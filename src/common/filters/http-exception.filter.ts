import {
  ExceptionFilter,
  Catch,
  ArgumentsHost,
  HttpException,
  HttpStatus,
} from '@nestjs/common';
import { Request, Response } from 'express';
import { PinoLogger } from 'nestjs-pino';

/**
 * Uniform exception filter for the Bonde API.
 *
 * Every HTTP error leaves the server with exactly the same shape so clients
 * (admin dashboard, mobile app) can rely on a single contract:
 *
 * ```json
 * {
 *   "statusCode": 400,
 *   "error": "Bad Request",
 *   "message": "Short, human-readable hint (never internals)"
 * }
 * ```
 *
 * - `stack` is never sent in production.
 * - The raw error detail is logged server-side for debugging.
 */
@Catch()
export class HttpExceptionFilter implements ExceptionFilter {
  constructor(private readonly logger: PinoLogger) {
    this.logger.setContext('ExceptionFilter');
  }

  catch(exception: unknown, host: ArgumentsHost): void {
    const ctx = host.switchToHttp();
    const response = ctx.getResponse<Response>();
    const request = ctx.getRequest<Request>();
    const requestId = (request as Request & { id?: string | number }).id;
    const safePath = request.path;

    const status =
      exception instanceof HttpException ? exception.getStatus() : HttpStatus.INTERNAL_SERVER_ERROR;

    const errorResponse =
      exception instanceof HttpException ? exception.getResponse() : 'Internal Server Error';

    const message =
      typeof errorResponse === 'string'
        ? errorResponse
        : typeof errorResponse === 'object' && errorResponse !== null
          ? ((errorResponse as Record<string, unknown>).message ?? 'Internal Server Error')
          : 'Internal Server Error';

    const errorName = exception instanceof HttpException ? exception.name : 'InternalServerError';

    // Keep 4xx noise low. For 5xx, log enough to debug server-side while
    // deliberately omitting headers, body, query string, and raw exception
    // objects (which can contain credentials or personal data).
    if (status >= 500) {
      const error = exception instanceof Error ? exception : undefined;
      const safeMessage = redactSecrets(error?.message ?? String(exception));
      const safeStack = error?.stack ? redactSecrets(error.stack) : undefined;
      this.logger.error(
        {
          requestId,
          method: request.method,
          path: safePath,
          status,
          errorName: error?.name ?? 'UnknownError',
          errorMessage: safeMessage,
          ...(safeStack ? { stack: safeStack } : {}),
        },
        'Request failed',
      );
    }

    response.status(status).json({
      statusCode: status,
      error: errorName,
      message: Array.isArray(message) ? message : [message],
      timestamp: new Date().toISOString(),
      path: safePath,
    });
  }
}

/** Scrub common credential formats before error text reaches hosted logs. */
function redactSecrets(value: string): string {
  return value
    .replace(/Bearer\s+\S+/gi, 'Bearer [REDACTED]')
    .replace(/eyJ[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+/g, '[JWT REDACTED]')
    .replace(/(password|secret|token|api[_-]?key)(\s*[=:]\s*)[^\s,;]+/gi, '$1$2[REDACTED]');
}
