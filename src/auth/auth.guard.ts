import { CanActivate, ExecutionContext, Injectable, UnauthorizedException } from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import type { Request } from 'express';
import { IS_PUBLIC_KEY } from './public.decorator.js';
import { JwksService } from './jwks.service.js';
import type { AuthPrincipal } from './auth-principal.js';

export interface AuthedRequest extends Request {
  user?: AuthPrincipal;
}

/**
 * Global authentication guard. Verifies `Authorization: Bearer <access token>`
 * against the Supabase JWKS and attaches the resulting `AuthPrincipal` to the
 * request. Routes marked `@Public()` bypass verification.
 */
@Injectable()
export class SupabaseAuthGuard implements CanActivate {
  constructor(
    private readonly reflector: Reflector,
    private readonly jwks: JwksService,
  ) {}

  async canActivate(context: ExecutionContext): Promise<boolean> {
    if (this.isPublic(context)) return true;

    const request = context.switchToHttp().getRequest<AuthedRequest>();
    const token = this.extractBearerToken(request);
    if (!token) {
      throw new UnauthorizedException('Missing bearer token');
    }

    request.user = await this.jwks.verify(token);
    return true;
  }

  private isPublic(context: ExecutionContext): boolean {
    return (
      this.reflector.getAllAndOverride<boolean>(IS_PUBLIC_KEY, [
        context.getHandler(),
        context.getClass(),
      ]) ?? false
    );
  }

  private extractBearerToken(request: Request): string | null {
    const header = request.headers.authorization;
    if (!header) return null;
    const [scheme, token, ...rest] = header.split(' ');
    if (scheme?.toLowerCase() !== 'bearer' || !token || rest.length > 0) return null;
    return token;
  }
}
