import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { BiometricType } from '@prisma/client';
import { Type } from 'class-transformer';
import {
  IsBoolean,
  IsIn,
  IsInt,
  IsOptional,
  IsString,
  Max,
  MaxLength,
  Min,
  MinLength,
} from 'class-validator';

/** Query parameters for `GET /api/biometric-devices`. */
export class ListBiometricsQueryDto {
  @ApiPropertyOptional({
    example: 'iPhone',
    description: 'Free-text search across the device ID and device name',
  })
  @IsOptional()
  @IsString()
  @MaxLength(100)
  q?: string;

  @ApiPropertyOptional({
    example: 'biometricType:FACE',
    description:
      'Repeatable `field:value` or `field:op:value` filters (`biometricType`, `isActive`)',
  })
  @IsOptional()
  filter?: string | string[];

  @ApiPropertyOptional({ example: 1, minimum: 1 })
  @IsOptional()
  @IsInt()
  @Min(1)
  @Type(() => Number)
  page?: number;

  @ApiPropertyOptional({ example: 20, minimum: 1, maximum: 100 })
  @IsOptional()
  @IsInt()
  @Min(1)
  @Max(100)
  @Type(() => Number)
  pageSize?: number;
}

/** Body for `POST /api/biometric-devices`. */
export class CreateBiometricDeviceDto {
  @ApiProperty({ example: 'device-abc-123' })
  @IsString()
  @MinLength(1)
  @MaxLength(255)
  deviceId: string;

  @ApiProperty({ example: 'iPhone 15 Pro' })
  @IsString()
  @MinLength(1)
  @MaxLength(100)
  deviceName: string;

  @ApiProperty({ enum: BiometricType, example: BiometricType.FACE })
  @IsIn(Object.values(BiometricType))
  biometricType: BiometricType;

  @ApiProperty({
    example: 'base64-public-key',
    description: 'Verification public key (device secure enclave)',
  })
  @IsString()
  @MinLength(1)
  publicKey: string;
}

/** Body for `PATCH /api/biometric-devices/:id`. */
export class UpdateBiometricDeviceDto {
  @ApiPropertyOptional({ example: 'Work phone' })
  @IsOptional()
  @IsString()
  @MinLength(1)
  @MaxLength(100)
  deviceName?: string;

  @ApiPropertyOptional({ example: false })
  @IsOptional()
  @IsBoolean()
  isActive?: boolean;
}

/** A registered biometric device, returned to its owner. */
export class BiometricDeviceDto {
  @ApiProperty({ format: 'uuid', example: '673bc257-9204-4acb-acf5-61f51e20a328' })
  id: string;

  @ApiProperty({ format: 'uuid', example: '673bc257-9204-4acb-acf5-61f51e20a328' })
  userId: string;

  @ApiProperty({ example: 'device-abc-123' })
  deviceId: string;

  @ApiProperty({ example: 'iPhone 15 Pro' })
  deviceName: string;

  @ApiProperty({ enum: BiometricType, example: BiometricType.FACE })
  biometricType: BiometricType;

  @ApiProperty({ example: true })
  isActive: boolean;

  @ApiProperty({ type: String, format: 'date-time', nullable: true })
  lastUsedAt: Date | null;

  @ApiProperty({ type: String, format: 'date-time' })
  createdAt: Date;

  @ApiProperty({ type: String, format: 'date-time' })
  updatedAt: Date;
}

/** Paged envelope for `GET /api/biometric-devices`. */
export class PagedBiometricsDto {
  @ApiProperty({ type: [BiometricDeviceDto] })
  items: BiometricDeviceDto[];

  @ApiProperty({ example: 1 })
  total: number;

  @ApiProperty({ example: 1 })
  page: number;

  @ApiProperty({ example: 20 })
  pageSize: number;

  @ApiProperty({ example: 1 })
  totalPages: number;
}

/** Response for `DELETE /api/biometric-devices/:id`. */
export class BiometricsDeleteResponseDto {
  @ApiProperty({ example: true })
  deleted: true;

  @ApiProperty({ format: 'uuid', example: '673bc257-9204-4acb-acf5-61f51e20a328' })
  id: string;
}
