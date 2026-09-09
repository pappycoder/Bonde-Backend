import { ApiProperty } from '@nestjs/swagger';

/**
 * Uniform error response emitted by the global `HttpExceptionFilter` for every
 * 4xx/5xx response — the single error contract shared by the admin dashboard
 * and the mobile app.
 */
export class ApiErrorDto {
  @ApiProperty({ example: 401 })
  statusCode: number;

  @ApiProperty({ example: 'UnauthorizedException' })
  error: string;

  @ApiProperty({ type: [String], example: ['Missing bearer token'] })
  message: string[];

  @ApiProperty({ example: '2026-09-09T12:00:00.000Z', format: 'date-time' })
  timestamp: string;

  @ApiProperty({ example: '/api/auth/me' })
  path: string;
}
