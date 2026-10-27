import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { Type } from 'class-transformer';
import { PaymentPreviewDto } from './payment-preview.dto.js';
import {
  ArrayMaxSize,
  IsArray,
  IsBoolean,
  IsIn,
  IsObject,
  IsOptional,
  IsString,
  IsUUID,
  Matches,
  MaxLength,
  MinLength,
  ValidateNested,
} from 'class-validator';

export class ChatProductDto {
  @IsOptional()
  @IsBoolean()
  requiresDelivery?: boolean;
  @IsOptional()
  @ValidateNested()
  @Type(() => PaymentPreviewDto)
  preview?: PaymentPreviewDto;
  @IsOptional()
  @IsUUID('4')
  id?: string;
  @IsString()
  @MinLength(1)
  @MaxLength(200)
  title: string;
  @IsString()
  @MinLength(1)
  @MaxLength(100)
  merchant: string;
  @Matches(/^\d{1,13}(\.\d{1,2})?$/)
  amount: string;
  @Matches(/^[A-Z]{3}$/)
  currency: string;
  @IsOptional()
  @Matches(/^\d{1,13}(\.\d{1,2})?$/)
  authorizedLimit?: string;
  @IsOptional()
  @IsString()
  @Matches(/^https:\/\//)
  @MaxLength(2000)
  imageUrl?: string;
  @IsOptional()
  @IsObject()
  specifications?: Record<string, string>;
  @IsOptional()
  @IsUUID('4')
  approvalId?: string;
  @IsOptional()
  @IsIn(['PENDING', 'APPROVED', 'DECLINED'])
  decision?: string;
}

/** Provider-neutral response contract; only trusted backend integrations write it. */
export class AssistantReplyDto {
  @IsString()
  @MaxLength(8000)
  text: string;
  @IsArray()
  @ArrayMaxSize(20)
  @ValidateNested({ each: true })
  @Type(() => ChatProductDto)
  items: ChatProductDto[];
}
export class RespondToMessageDto {
  @ApiProperty({ format: 'uuid' })
  @IsUUID('4')
  messageId: string;
}
export class ChatItemDecisionDto {
  @ApiProperty({ enum: ['APPROVED', 'DECLINED'] })
  @IsIn(['APPROVED', 'DECLINED'])
  decision: 'APPROVED' | 'DECLINED';
}
export class ChatDecisionResponseDto {
  @ApiProperty({ format: 'uuid' })
  itemId: string;
  @ApiProperty({ enum: ['APPROVED', 'DECLINED'] })
  decision: string;
  @ApiPropertyOptional({ format: 'uuid' })
  approvalId?: string;
}
