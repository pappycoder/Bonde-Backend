import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { CardRestrictedCategory, CardStatus, LockType } from '@prisma/client';
import { Transform, Type } from 'class-transformer';
import {
  IsBoolean,
  IsIn,
  IsInt,
  IsISO8601,
  IsObject,
  IsOptional,
  IsString,
  Matches,
  Max,
  MaxLength,
  Min,
} from 'class-validator';

const DECIMAL_PATTERN = /^\d+(\.\d{1,2})?$/;
const CARD_TYPES = ['virtual'];

/** Query parameters for `GET /api/cards`. */
export class ListCardsQueryDto {
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

/** Body for `POST /api/cards`. */
export class CreateCardDto {
  @ApiPropertyOptional({ example: 'virtual', description: 'Only virtual cards can be created' })
  @IsOptional()
  @IsIn(CARD_TYPES)
  cardType?: string;

  @ApiPropertyOptional({ example: 'Weekend spending', maxLength: 100 })
  @IsOptional()
  @IsString()
  @MaxLength(100)
  @Transform(({ value }) => value?.trim())
  nickname?: string;

  @ApiPropertyOptional({ example: '10000.00', description: 'Single-transaction cap' })
  @IsOptional()
  @Matches(DECIMAL_PATTERN, { message: 'maxSpendLimit must be a decimal with up to 2 places' })
  maxSpendLimit?: string;

  @ApiPropertyOptional({ example: '20000.00', description: 'Per-month cap' })
  @IsOptional()
  @Matches(DECIMAL_PATTERN, { message: 'monthlyLimit must be a decimal with up to 2 places' })
  monthlyLimit?: string;

  @ApiPropertyOptional({ enum: ['monthly', 'yearly'], example: 'monthly' })
  @IsOptional()
  @IsIn(['monthly', 'yearly'])
  expirationType?: string;

  @ApiPropertyOptional({
    type: String,
    format: 'date-time',
    description: 'Derived from expirationType when omitted',
  })
  @IsOptional()
  @IsISO8601({ strict: true })
  expirationDate?: string;
}

/** Body for `PATCH /api/cards/:id`. */
export class UpdateCardDto {
  @ApiPropertyOptional({ example: 'Weekend spending', maxLength: 100 })
  @IsOptional()
  @IsString()
  @MaxLength(100)
  @Transform(({ value }) => value?.trim())
  nickname?: string;

  @ApiPropertyOptional({ example: 'virtual' })
  @IsOptional()
  @IsIn(CARD_TYPES)
  cardType?: string;

  @ApiPropertyOptional({ example: '10000.00', description: 'Single-transaction cap' })
  @IsOptional()
  @Matches(DECIMAL_PATTERN, { message: 'maxSpendLimit must be a decimal with up to 2 places' })
  maxSpendLimit?: string;

  @ApiPropertyOptional({ example: '20000.00', description: 'Per-month cap' })
  @IsOptional()
  @Matches(DECIMAL_PATTERN, { message: 'monthlyLimit must be a decimal with up to 2 places' })
  monthlyLimit?: string;
}

/** Body for `POST /api/cards/:id/merchants`. */
export class CreateCardMerchantDto {
  @ApiProperty({ example: 'Acme Stores', maxLength: 200 })
  @IsString()
  @MaxLength(200)
  @Transform(({ value }) => value?.trim())
  merchantName: string;

  @ApiPropertyOptional({ example: 'M-ACME-001', maxLength: 100 })
  @IsOptional()
  @IsString()
  @MaxLength(100)
  @Transform(({ value }) => value?.trim())
  merchantCode?: string;
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

/** Body for `PATCH /api/cards/:id/limit` — at least one limit is required. */
export class UpdateCardLimitDto {
  @ApiPropertyOptional({ example: '10000.00', description: 'Single-transaction cap' })
  @IsOptional()
  @Matches(DECIMAL_PATTERN, { message: 'maxSpendLimit must be a decimal with up to 2 places' })
  maxSpendLimit?: string;

  @ApiPropertyOptional({ example: '20000.00', description: 'Per-month cap' })
  @IsOptional()
  @Matches(DECIMAL_PATTERN, { message: 'monthlyLimit must be a decimal with up to 2 places' })
  monthlyLimit?: string;
}

/** Body for `POST /api/cards/:id/locks`. */
export class CreateCardLockDto {
  @ApiProperty({ enum: LockType, example: LockType.MERCHANT })
  @IsIn(Object.values(LockType))
  lockType: LockType;

  @ApiPropertyOptional({ type: Object, additionalProperties: true })
  @IsOptional()
  @IsObject()
  config?: Record<string, unknown>;

  @ApiPropertyOptional({ example: true })
  @IsOptional()
  @IsBoolean()
  isActive?: boolean;
}

/** Body for `PATCH /api/cards/:id/locks/:lockId`. */
export class UpdateCardLockDto {
  @ApiPropertyOptional({ type: Object, additionalProperties: true })
  @IsOptional()
  @IsObject()
  config?: Record<string, unknown>;

  @ApiPropertyOptional({ example: false })
  @IsOptional()
  @IsBoolean()
  isActive?: boolean;
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

/** Body for `POST /api/cards/:id/categories`. */
export class CreateCardCategoryDto {
  @ApiProperty({ enum: CardRestrictedCategory, example: CardRestrictedCategory.TRAVEL_HOTEL })
  @IsIn(Object.values(CardRestrictedCategory))
  category: CardRestrictedCategory;

  @ApiPropertyOptional({ example: false, description: 'Deny-by-default' })
  @IsOptional()
  @IsBoolean()
  isAllowed?: boolean;
}

/** Body for `PATCH /api/cards/:id/categories/:categoryId`. */
export class UpdateCardCategoryDto {
  @ApiProperty({ example: true })
  @IsBoolean()
  isAllowed: boolean;
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

/** Response for deletes. */
export class CardsDeleteResponseDto {
  @ApiProperty({ example: true })
  deleted: true;

  @ApiProperty({ format: 'uuid', example: '673bc257-9204-4acb-acf5-61f51e20a328' })
  id: string;
}
