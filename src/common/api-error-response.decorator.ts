import { applyDecorators, HttpStatus } from '@nestjs/common';
import { ApiResponse } from '@nestjs/swagger';
import { ApiErrorDto } from './api-error.dto.js';

const ERROR_STATUSES: Record<number, string> = {
  [HttpStatus.BAD_REQUEST]: 'Validation or malformed request',
  [HttpStatus.UNAUTHORIZED]: 'Missing/expired bearer token (or invalid credentials)',
  [HttpStatus.FORBIDDEN]: 'Authenticated but insufficient role',
  [HttpStatus.NOT_FOUND]: 'Route not found',
  [HttpStatus.CONFLICT]: 'Resource state conflict',
  [HttpStatus.TOO_MANY_REQUESTS]: 'Rate limit exceeded (or temporarily blocked)',
  [HttpStatus.SERVICE_UNAVAILABLE]: 'Dependency (e.g. Redis) unreachable — retry later',
  [HttpStatus.INTERNAL_SERVER_ERROR]: 'Unexpected server error',
};

/**
 * Documents the uniform error responses emitted by `HttpExceptionFilter`
 * (`ApiErrorDto`) for every status the API can return.
 */
export function ApiErrorResponse(): MethodDecorator & ClassDecorator {
  return applyDecorators(
    ...Object.entries(ERROR_STATUSES).map(([status, description]) =>
      ApiResponse({
        status: Number(status),
        description,
        type: ApiErrorDto,
      }),
    ),
  );
}
