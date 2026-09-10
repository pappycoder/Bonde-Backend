import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { IsBoolean, IsOptional, IsString, Matches, MaxLength, MinLength } from 'class-validator';

/** Request body for `PATCH /api/profile` — any subset of the writable fields. */
export class UpdateProfileDto {
  @ApiPropertyOptional({ example: 'Amina Sule' })
  @IsOptional()
  @IsString()
  @MinLength(1)
  @MaxLength(255)
  fullName?: string;

  @ApiPropertyOptional({ example: '+2348000000000' })
  @IsOptional()
  @IsString()
  @MinLength(7)
  @MaxLength(20)
  @Matches(/^\+?[0-9]+$/, { message: 'phone must contain only digits and an optional leading +' })
  phone?: string;

  @ApiPropertyOptional({ description: 'Set true to stamp onboarding as completed', example: true })
  @IsOptional()
  @IsBoolean()
  onboardingCompleted?: boolean;
}

/** Request body for `PATCH /api/profile/avatar`. */
export class UpdateAvatarDto {
  @ApiProperty({ example: 'u-673bc257-9204-4acb-acf5-61f51e20a328/avatar.jpeg' })
  @IsString()
  @MinLength(1)
  @MaxLength(1024)
  path: string;
}

/** Profile as returned to the owning user. */
export class ProfileDto {
  @ApiProperty({ format: 'uuid', example: '673bc257-9204-4acb-acf5-61f51e20a328' })
  id: string;

  @ApiProperty({ example: 'Amina Sule' })
  fullName: string;

  @ApiProperty({ example: 'amina@bonde.app' })
  email: string;

  @ApiProperty({ type: String, nullable: true, example: '+2348000000000' })
  phone: string | null;

  @ApiProperty({ example: false })
  phoneVerified: boolean;

  @ApiProperty({ example: false })
  emailVerified: boolean;

  @ApiProperty({ type: String, nullable: true, example: 'https://…/bonde-avatars/u-…/avatar.jpeg' })
  avatarUrl: string | null;

  @ApiProperty({ type: String, format: 'date-time', nullable: true })
  onboardingCompletedAt: Date | null;

  @ApiProperty({ type: String, format: 'date-time' })
  createdAt: Date;

  @ApiProperty({ type: String, format: 'date-time' })
  updatedAt: Date;
}
