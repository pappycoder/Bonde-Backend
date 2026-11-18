import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { Type } from 'class-transformer';
import { PaymentPreviewDto } from './payment-preview.dto.js';
import { DeliveryAddressInputDto } from '../profiles/delivery-address.dto.js';
import {
  subscriptionServiceIds,
  subscriptionCheckoutUrls,
  subscriptionSourceUrls,
  type SubscriptionServiceId,
} from './subscription-catalog.js';
import {
  ArrayMaxSize,
  IsDefined,
  IsDateString,
  IsArray,
  IsBoolean,
  IsIn,
  IsISO31661Alpha2,
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
  @ApiPropertyOptional({ type: () => PaymentPreviewDto })
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
  /**
   * One-time delivery address attached to an approved purchase when the buyer chose
   * NOT to save it to their address book. Mirrors the saved-address shape minus ids.
   */
  @IsOptional()
  @ValidateNested()
  @ApiPropertyOptional({ type: () => DeliveryAddressInputDto })
  @Type(() => DeliveryAddressInputDto)
  deliveryAddress?: DeliveryAddressInputDto;
}

/** Provider-neutral response contract; only trusted backend integrations write it. */
export class AssistantReplyDto {
  @ApiPropertyOptional({ type: () => [ChatSubscriptionDto] })
  @IsOptional()
  @IsArray()
  @ArrayMaxSize(2)
  @ValidateNested({ each: true })
  @Type(() => ChatSubscriptionDto)
  subscriptions?: ChatSubscriptionDto[];
  @ApiPropertyOptional({ type: () => [ShoppingDiscoveryDto] })
  @IsOptional()
  @IsArray()
  @ArrayMaxSize(10)
  @ValidateNested({ each: true })
  @Type(() => ShoppingDiscoveryDto)
  discoveries?: ShoppingDiscoveryDto[];
  @ApiPropertyOptional({ type: () => [ChatServiceQuoteDto] })
  @IsOptional()
  @IsArray()
  @ArrayMaxSize(3)
  @ValidateNested({ each: true })
  @Type(() => ChatServiceQuoteDto)
  serviceQuotes?: ChatServiceQuoteDto[];
  @IsString()
  @MaxLength(8000)
  text: string;
  @IsArray()
  @ArrayMaxSize(20)
  @ValidateNested({ each: true })
  @ApiProperty({ type: () => [ChatProductDto] })
  @Type(() => ChatProductDto)
  items: ChatProductDto[];
}
export class RespondToMessageDto {
  @ApiProperty({ format: 'uuid' })
  @IsUUID('4')
  messageId: string;
}

export class ChatSubscriptionDto {
  @IsUUID('4') id!: string;
  @IsIn(subscriptionServiceIds) serviceId!: SubscriptionServiceId;
  @IsString() @MaxLength(100) name!: string;
  @IsISO31661Alpha2() countryCode!: string;
  @IsIn(['NEW', 'RENEW']) intent!: 'NEW' | 'RENEW';
  @IsIn(subscriptionCheckoutUrls)
  checkoutUrl!: string;
  @IsIn(subscriptionSourceUrls)
  sourceUrl!: string;
  @IsIn(['CHECK_AT_CHECKOUT']) priceStatus!: string;
  @IsIn(['UNVERIFIED']) activationStatus!: string;
  @IsString() @MaxLength(1000) billingNote!: string;
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

export class ShoppingDiscoveryDto {
  @IsOptional()
  @IsArray()
  @ArrayMaxSize(8)
  @IsString({ each: true })
  @MaxLength(4000, { each: true })
  @Matches(/^https:\/\//, { each: true })
  imageUrls?: string[];
  @IsOptional() @IsIn(['READ', 'BROWSER_REQUIRED']) detailsStatus?: 'READ' | 'BROWSER_REQUIRED';
  @IsOptional() @IsString() @MaxLength(4000) @Matches(/^https:\/\//) imageUrl?: string;
  @IsOptional() @IsString() @Matches(/^\d{1,13}(\.\d{1,2})?$/) amount?: string;
  @IsOptional() @IsString() @Matches(/^[A-Z]{3}$/) currency?: string;
  @IsOptional() @IsString() @MaxLength(100) availability?: string;
  @IsOptional() @IsString() @MaxLength(200) priceNote?: string;
  @IsOptional() @IsObject() specifications?: Record<string, string>;

  @ApiPropertyOptional({
    description: 'Original product discovery time, preserved when results are reused.',
  })
  @IsOptional()
  @IsDateString()
  discoveredAt?: string;
  @IsUUID('4') id!: string;
  @IsString() @MaxLength(300) title!: string;
  @IsString() @MaxLength(255) merchant!: string;
  @IsString() @MaxLength(4000) @Matches(/^https:\/\//) url!: string;
  @IsString() @MaxLength(8000) description!: string;
  @IsBoolean() priceVerified!: boolean;
  @IsBoolean() availabilityVerified!: boolean;
  @IsIn(['OFFICIAL_LINK']) checkout!: string;
}
export class ChatServiceQuoteDto {
  @IsUUID('4') id!: string;
  @IsString() serviceId!: string;
  @IsString() variationCode!: string;
  @IsString() name!: string;
  @IsString() beneficiary!: string;
  @IsOptional() @IsString() beneficiaryName?: string | null;
  @IsString() phone!: string;
  @IsString() amount!: string;
  @IsString() fee!: string;
  @IsString() total!: string;
  @IsIn(['NGN']) currency!: string;
  @IsDefined() expiresAt!: Date | string;
  @IsBoolean() autoRenew!: boolean;
}
