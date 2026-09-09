export const ROLES = ['USER', 'ADMIN', 'SUPER_ADMIN'] as const;

export type BondeRole = (typeof ROLES)[number];

export const ROLE_HIERARCHY: Record<BondeRole, number> = {
  USER: 0,
  ADMIN: 1,
  SUPER_ADMIN: 2,
};

export interface AuthPrincipal {
  /** Supabase `auth.users.id` (JWT `sub`). */
  userId: string;
  email: string | null;
  phone: string | null;
  role: BondeRole;
  appMetadata: Record<string, unknown>;
  userMetadata: Record<string, unknown>;
}
