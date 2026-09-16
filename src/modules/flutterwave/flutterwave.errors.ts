import {
  BadGatewayException,
  BadRequestException,
  ConflictException,
  ServiceUnavailableException,
} from '@nestjs/common';

/**
 * Domain of failure surfaced by the Flutterwave payment provider. Feature
 * services map these to HTTP semantics: `VALIDATION` → 400, `CONFIG` / stale
 * credentials → 503, `PROVIDER` / network → 502.
 */
export type FlutterwaveErrorCode = 'VALIDATION' | 'CONFIG' | 'PROVIDER' | 'DUPLICATE_REFERENCE';

/** Provider failure with a normalized, mappable code. */
export class FlutterwaveError extends Error {
  constructor(
    readonly code: FlutterwaveErrorCode,
    message: string,
  ) {
    super(message);
    this.name = 'FlutterwaveError';
  }
}

/** Convert a provider error into the HTTP exception a controller can surface. */
export function throwFlutterwaveHttp(error: unknown): never {
  if (error instanceof FlutterwaveError) {
    switch (error.code) {
      case 'VALIDATION':
        throw new BadRequestException(error.message);
      case 'DUPLICATE_REFERENCE':
        throw new ConflictException(error.message);
      case 'CONFIG':
        throw new ServiceUnavailableException(error.message);
      default:
        throw new BadGatewayException(error.message);
    }
  }
  throw error;
}
