import { SetMetadata } from '@nestjs/common';

export const IS_PUBLIC_KEY = 'isPublic';

/**
 * Marks a route (or controller) as exempt from authentication.
 * Used by the global `SupabaseAuthGuard` and `RolesGuard`.
 */
export const Public = () => SetMetadata(IS_PUBLIC_KEY, true);
