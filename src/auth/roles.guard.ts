import { CanActivate, ExecutionContext, ForbiddenException, Injectable } from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import { IS_PUBLIC_KEY } from './public.decorator.js';
import { ROLES_KEY } from './roles.decorator.js';
import { ROLE_HIERARCHY, type BondeRole } from './auth-principal.js';
import type { AuthedRequest } from './auth.guard.js';

/**
 * Global RBAC guard. Enforces `@Roles(...)` metadata against the authenticated
 * principal's role using the `SUPER_ADMIN > ADMIN > USER` hierarchy. Routes
 * without `@Roles()` allow any authenticated user; `@Public()` routes skip it.
 */
@Injectable()
export class RolesGuard implements CanActivate {
  constructor(private readonly reflector: Reflector) {}

  canActivate(context: ExecutionContext): boolean {
    if (this.isPublic(context)) return true;

    const required = this.reflector.getAllAndOverride<BondeRole[]>(ROLES_KEY, [
      context.getHandler(),
      context.getClass(),
    ]);
    if (!required?.length) return true;

    const request = context.switchToHttp().getRequest<AuthedRequest>();
    const principal = request.user;
    if (!principal) {
      throw new ForbiddenException('No authenticated principal');
    }

    const requiredRank = Math.min(...required.map((r) => ROLE_HIERARCHY[r]));
    const actualRank = ROLE_HIERARCHY[principal.role] ?? -1;
    if (actualRank < requiredRank) {
      throw new ForbiddenException('Insufficient role');
    }
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
}
