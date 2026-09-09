import { createParamDecorator, ExecutionContext, UnauthorizedException } from '@nestjs/common';
import type { AuthPrincipal } from './auth-principal.js';

interface AuthedRequest {
  user?: AuthPrincipal;
}

/**
 * Injects the verified `AuthPrincipal` attached to the request by the global
 * `SupabaseAuthGuard`. Only usable on authenticated routes.
 */
export const CurrentUser = createParamDecorator(
  (_data: unknown, context: ExecutionContext): AuthPrincipal => {
    const request = context.switchToHttp().getRequest<AuthedRequest>();
    if (!request.user) {
      throw new UnauthorizedException('No authenticated principal');
    }
    return request.user;
  },
);
