import { ApiProperty } from '@nestjs/swagger';
import {
  IsIn,
  IsInt,
  IsNotEmpty,
  IsOptional,
  IsString,
  Max,
  MaxLength,
  Min,
} from 'class-validator';
import { STORAGE_BUCKET_NAMES } from './storage.types.js';

/** Request body for `POST /api/storage/upload-url`. */
export class SignUploadUrlDto {
  @ApiProperty({ enum: STORAGE_BUCKET_NAMES, example: 'bonde-avatars' })
  @IsString()
  @IsNotEmpty()
  @IsIn(STORAGE_BUCKET_NAMES)
  bucket: string;

  @ApiProperty({ example: 'u-123/avatar.jpeg' })
  @IsString()
  @IsNotEmpty()
  @MaxLength(1024)
  path: string;

  @ApiProperty({ example: 'image/jpeg' })
  @IsString()
  @IsNotEmpty()
  contentType: string;

  @ApiProperty({ required: false, example: 512_000 })
  @IsOptional()
  @IsInt()
  @Min(1)
  size?: number;

  @ApiProperty({ required: false, example: 900, description: 'Seconds (clamped to bucket bounds)' })
  @IsOptional()
  @IsInt()
  @Min(1)
  @Max(86400)
  expiresIn?: number;
}

/** Query parameters for `GET /api/storage/signed-url`. */
export class SignUrlQueryDto {
  @ApiProperty({ enum: STORAGE_BUCKET_NAMES, example: 'bonde-kyc-docs' })
  @IsString()
  @IsNotEmpty()
  @IsIn(STORAGE_BUCKET_NAMES)
  bucket: string;

  @ApiProperty({ example: 'u-123/kyc-id.pdf' })
  @IsString()
  @IsNotEmpty()
  @MaxLength(1024)
  path: string;

  @ApiProperty({ required: false, example: 600, description: 'Seconds (clamped to bucket bounds)' })
  @IsOptional()
  @IsInt()
  @Min(1)
  @Max(86400)
  expiresIn?: number;
}

/** Query parameters for `GET /api/storage/public-url`. */
export class PublicUrlQueryDto {
  @ApiProperty({ enum: STORAGE_BUCKET_NAMES, example: 'bonde-avatars' })
  @IsString()
  @IsNotEmpty()
  @IsIn(STORAGE_BUCKET_NAMES)
  bucket: string;

  @ApiProperty({ example: 'u-123/avatar.jpeg' })
  @IsString()
  @IsNotEmpty()
  @MaxLength(1024)
  path: string;
}

/** Response shape for `POST /api/storage/upload-url`. */
export class SignedUploadUrlResponseDto {
  @ApiProperty({ example: 'bonde-avatars' })
  bucket: string;

  @ApiProperty({ example: 'u-123/avatar.jpeg' })
  path: string;

  @ApiProperty({ example: 'PUT' })
  method: 'PUT';

  @ApiProperty({
    example: 'https://…/storage/v1/object/upload/sign/bonde-avatars/u-123%2Favatar.jpeg?token=…',
  })
  uploadUrl: string;

  @ApiProperty({ example: { 'content-type': 'image/jpeg' } })
  headers: Record<string, string>;

  @ApiProperty({ example: 900 })
  expiresIn: number;
}

/** Response shape for `GET /api/storage/signed-url`. */
export class SignedUrlResponseDto {
  @ApiProperty({ example: 'bonde-kyc-docs' })
  bucket: string;

  @ApiProperty({ example: 'u-123/kyc-id.pdf' })
  path: string;

  @ApiProperty({ example: 'https://…/storage/v1/object/…?token=…' })
  signedUrl: string;

  @ApiProperty({ example: 600 })
  expiresIn: number;
}

/** Response shape for `GET /api/storage/public-url`. */
export class PublicUrlResponseDto {
  @ApiProperty({ example: 'bonde-avatars' })
  bucket: string;

  @ApiProperty({ example: 'u-123/avatar.jpeg' })
  path: string;

  @ApiProperty({ example: 'https://…/storage/v1/object/public/bonde-avatars/u-123/avatar.jpeg' })
  publicUrl: string;
}
