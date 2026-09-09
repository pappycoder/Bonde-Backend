import { SetMetadata } from '@nestjs/common';
import type { BondeRole } from '../principal/auth-principal.js';

export const ROLES_KEY = 'roles';

/**
 * Restricts a route to the given roles (and any superior role via the
 * `SUPER_ADMIN > ADMIN > USER` hierarchy). Absent metadata = any authenticated
 * user is allowed.
 */
export const Roles = (...roles: BondeRole[]) => SetMetadata(ROLES_KEY, roles);
