import {
  ExceptionFilter,
  Catch,
  ArgumentsHost,
  HttpException,
  HttpStatus,
  Logger,
} from '@nestjs/common';
import { Request, Response } from 'express';

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
  private readonly logger = new Logger('ExceptionFilter');

  catch(exception: unknown, host: ArgumentsHost): void {
    const ctx = host.switchToHttp();
    const response = ctx.getResponse<Response>();
    const request = ctx.getRequest<Request>();

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

    // Log 5xx and unexpected errors; 4xx logged at warn level for monitoring.
    const logLevel = status >= 500 ? 'error' : 'warn';
    this.logger[logLevel](
      `${request.method} ${request.originalUrl} → ${status}`,
      exception instanceof Error ? exception.stack : undefined,
    );

    response.status(status).json({
      statusCode: status,
      error: errorName,
      message: Array.isArray(message) ? message : [message],
      timestamp: new Date().toISOString(),
      path: request.originalUrl,
    });
  }
}
