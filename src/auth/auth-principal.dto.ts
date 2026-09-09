import { ApiProperty } from '@nestjs/swagger';
import { ROLES, type BondeRole } from './auth-principal.js';

/**
 * Verified Supabase session principal attached to authenticated requests.
 * Returned by `GET /api/auth/me`.
 */
export class AuthPrincipalDto {
  @ApiProperty({ format: 'uuid', example: '673bc257-9204-4acb-acf5-61f51e20a328' })
  userId: string;

  @ApiProperty({ type: String, nullable: true, example: 'me@bonde.app' })
  email: string | null;

  @ApiProperty({ type: String, nullable: true, example: '+2348000000000' })
  phone: string | null;

  @ApiProperty({ enum: ROLES, enumName: 'BondeRole', example: 'USER' })
  role: BondeRole;

  @ApiProperty({ type: Object, additionalProperties: true })
  appMetadata: Record<string, unknown>;

  @ApiProperty({ type: Object, additionalProperties: true })
  userMetadata: Record<string, unknown>;
}
