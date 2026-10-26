import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { CardRestrictedCategory, CardStatus, LockType } from '@prisma/client';
import { Type } from 'class-transformer';
import { IsInt, IsOptional, IsString, Max, MaxLength, Min } from 'class-validator';

/** Query parameters for `GET /api/cards`. */
export class ListCardsQueryDto {
  @ApiPropertyOptional({
    example: 'weekend',
    description: 'Free-text search across the card nickname and last-4 digits',
  })
  @IsOptional()
  @IsString()
  @MaxLength(100)
  q?: string;

  @ApiPropertyOptional({
    example: 'status:ACTIVE',
    description:
      'Repeatable `field:value` (equality on enums/numbers) or `field:op:value` filters. Fields: cardType, status, expirationType.',
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

/** Query parameters for `GET /api/cards/:id/transactions`. */
export class ListCardTransactionsQueryDto {
  @ApiPropertyOptional({
    example: 'lunch',
    description: 'Free-text search across the transaction description',
  })
  @IsOptional()
  @IsString()
  @MaxLength(100)
  q?: string;

  @ApiPropertyOptional({
    example: 'status:SUCCESS',
    description:
      'Repeatable `field:value` (equality on enums/numbers) or `field:op:value` filters. Fields: status, type, approvalStatus, currency.',
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

/** A card as returned to the owning user — the PAN is never exposed. */
export class CardDto {
  @ApiProperty({ example: 'NGN' })
  currency: string;
  @ApiProperty({ format: 'uuid', example: '673bc257-9204-4acb-acf5-61f51e20a328' })
  id: string;

  @ApiProperty({ format: 'uuid', example: '673bc257-9204-4acb-acf5-61f51e20a328' })
  userId: string;

  @ApiProperty({ format: 'uuid', example: '673bc257-9204-4acb-acf5-61f51e20a328' })
  providerId: string;

  @ApiProperty({ example: '4242', description: 'Last 4 digits, shown for verification' })
  cardNumberLast4: string;

  @ApiProperty({ example: 'virtual' })
  cardType: string;

  @ApiProperty({ enum: CardStatus, example: CardStatus.ACTIVE })
  status: CardStatus;

  @ApiProperty({ type: String, nullable: true, example: 'Weekend spending' })
  nickname: string | null;

  @ApiProperty({ type: String, nullable: true, example: '10000.00' })
  maxSpendLimit: string | null;

  @ApiProperty({ type: String, nullable: true, example: '20000.00' })
  monthlyLimit: string | null;

  @ApiProperty({ example: true, description: 'Budget-locked: top-up permitted' })
  allowTopUp: boolean;

  @ApiProperty({ example: true, description: 'Notify at 50% of the budget' })
  notifyHalfSpent: boolean;

  @ApiProperty({ example: true, description: 'Notify on low balance' })
  notifyLowBalance: boolean;

  @ApiProperty({ example: true, description: 'Notify when the budget is reached' })
  notifyBudgetReached: boolean;

  @ApiProperty({ example: '2500.00', description: 'Cumulative spend through this card' })
  totalSpent: string;

  @ApiProperty({ example: '5000.00', description: 'Funded balance cache (provider-issued cards)' })
  balance: string;

  @ApiProperty({ example: 'monthly' })
  expirationType: string;

  @ApiProperty({ type: String, format: 'date-time' })
  expirationDate: Date;

  @ApiProperty({ type: String, nullable: true })
  externalReferenceId: string | null;

  @ApiProperty({ type: String, format: 'date-time' })
  createdAt: Date;

  @ApiProperty({ type: String, format: 'date-time' })
  updatedAt: Date;
}

/** A merchant the card is restricted to (allowlist). */
export class CardMerchantDto {
  @ApiProperty({ format: 'uuid', example: '673bc257-9204-4acb-acf5-61f51e20a328' })
  id: string;

  @ApiProperty({ format: 'uuid', example: '673bc257-9204-4acb-acf5-61f51e20a328' })
  cardId: string;

  @ApiProperty({ example: 'Acme Stores' })
  merchantName: string;

  @ApiProperty({ type: String, nullable: true, example: 'M-ACME-001' })
  merchantCode: string | null;

  @ApiProperty({ type: String, format: 'date-time' })
  createdAt: Date;
}

/** One entry in a card's change history. */
export class CardHistoryDto {
  @ApiProperty({ format: 'uuid', example: '673bc257-9204-4acb-acf5-61f51e20a328' })
  id: string;

  @ApiProperty({ format: 'uuid', example: '673bc257-9204-4acb-acf5-61f51e20a328' })
  cardId: string;

  @ApiProperty({ example: 'update' })
  event: string;

  @ApiProperty({ type: Object, additionalProperties: true })
  changes: Record<string, unknown>;

  @ApiProperty({ type: String, format: 'date-time' })
  createdAt: Date;
}

/** Paged envelope for `GET /api/cards`. */
export class PagedCardsDto {
  @ApiProperty({ type: [CardDto] })
  items: CardDto[];

  @ApiProperty({ example: 1 })
  total: number;

  @ApiProperty({ example: 1 })
  page: number;

  @ApiProperty({ example: 20 })
  pageSize: number;

  @ApiProperty({ example: 1 })
  totalPages: number;
}

/** A composable lock on a card. */
export class CardLockDto {
  @ApiProperty({ format: 'uuid', example: '673bc257-9204-4acb-acf5-61f51e20a328' })
  id: string;

  @ApiProperty({ format: 'uuid', example: '673bc257-9204-4acb-acf5-61f51e20a328' })
  cardId: string;

  @ApiProperty({ enum: LockType, example: LockType.TIME })
  lockType: LockType;

  @ApiProperty({ type: Object, additionalProperties: true })
  config: Record<string, unknown>;

  @ApiProperty({ example: true })
  isActive: boolean;

  @ApiProperty({ type: String, format: 'date-time' })
  createdAt: Date;
}

/** A restricted spending category on a card. */
export class CardCategoryDto {
  @ApiProperty({ format: 'uuid', example: '673bc257-9204-4acb-acf5-61f51e20a328' })
  id: string;

  @ApiProperty({ format: 'uuid', example: '673bc257-9204-4acb-acf5-61f51e20a328' })
  cardId: string;

  @ApiProperty({ enum: CardRestrictedCategory, example: CardRestrictedCategory.FOOD_RESTAURANT })
  category: CardRestrictedCategory;

  @ApiProperty({ example: false })
  isAllowed: boolean;

  @ApiProperty({ type: String, format: 'date-time' })
  createdAt: Date;
}
