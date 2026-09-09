import { Body, Controller, Get, HttpCode, HttpStatus, Post, Query } from '@nestjs/common';
import {
  ApiBearerAuth,
  ApiCreatedResponse,
  ApiOkResponse,
  ApiOperation,
  ApiTags,
} from '@nestjs/swagger';
import { ApiErrorResponse } from '../errors/api-error-response.decorator.js';
import {
  PublicUrlQueryDto,
  PublicUrlResponseDto,
  SignedUploadUrlResponseDto,
  SignedUrlResponseDto,
  SignUploadUrlDto,
  SignUrlQueryDto,
} from './storage.dto.js';
import type { StorageBucketName } from './storage.types.js';
import { StorageService } from './storage.service.js';

/**
 * Thin signed-URL surface for Supabase Storage. These endpoints do not proxy
 * file bytes — they hand the client a short-lived URL so uploads/downloads go
 * straight to Supabase. Feature flows (avatars, KYC, chat media) build on
 * these in later phases.
 *
 * All endpoints are authenticated by default (global guard). The service-role
 * key is never returned; only signed URLs are.
 */
@ApiTags('storage')
@ApiBearerAuth('access-token')
@Controller('storage')
export class StorageController {
  constructor(private readonly storage: StorageService) {}

  @Post('upload-url')
  @HttpCode(HttpStatus.CREATED)
  @ApiOperation({ summary: 'Get a short-lived signed upload (PUT) URL' })
  @ApiCreatedResponse({ type: SignedUploadUrlResponseDto })
  @ApiErrorResponse()
  signUpload(@Body() dto: SignUploadUrlDto): Promise<SignedUploadUrlResponseDto> {
    return this.storage.signUploadUrl(dto.bucket as StorageBucketName, dto.path, {
      contentType: dto.contentType,
      size: dto.size,
      expiresIn: dto.expiresIn,
    });
  }

  @Get('signed-url')
  @ApiOperation({ summary: 'Get a short-lived signed read URL' })
  @ApiOkResponse({ type: SignedUrlResponseDto })
  @ApiErrorResponse()
  signDownload(@Query() query: SignUrlQueryDto): Promise<SignedUrlResponseDto> {
    return this.storage.signDownloadUrl(query.bucket as StorageBucketName, query.path, {
      expiresIn: query.expiresIn,
    });
  }

  @Get('public-url')
  @ApiOperation({ summary: 'Get the stable public URL (public buckets only)' })
  @ApiOkResponse({ type: PublicUrlResponseDto })
  @ApiErrorResponse()
  publicUrl(@Query() query: PublicUrlQueryDto): PublicUrlResponseDto {
    return this.storage.getPublicUrl(query.bucket as StorageBucketName, query.path);
  }
}
