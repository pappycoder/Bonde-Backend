import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import {
  ApprovalStatus,
  TransactionFrequency,
  TransactionStatus,
  TransactionType,
} from '@prisma/client';
import { Type } from 'class-transformer';
import { IsInt, IsOptional, IsString, Max, MaxLength, Min } from 'class-validator';

/** Query parameters for `GET /api/transactions`. */
export class ListTransactionsQueryDto {
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
      'Repeatable `field:value` (equality on enums/numbers) or `field:op:value`. Fields: status, type, approvalStatus, currency, frequency, isRecurring, thresholdWarning.',
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

/** Query parameters for `GET /api/transactions/recent`. */
export class RecentTransactionsQueryDto {
  @ApiPropertyOptional({ example: 10, minimum: 1, maximum: 50 })
  @IsOptional()
  @IsInt()
  @Min(1)
  @Max(50)
  @Type(() => Number)
  limit?: number;
}

/** A transaction as returned to the owning user. */
export class TransactionDto {
  @ApiProperty({ format: 'uuid', example: '673bc257-9204-4acb-acf5-61f51e20a328' })
  id: string;

  @ApiProperty({ format: 'uuid', example: '673bc257-9204-4acb-acf5-61f51e20a328' })
  userId: string;

  @ApiProperty({ format: 'uuid', example: '673bc257-9204-4acb-acf5-61f51e20a328' })
  walletId: string;

  @ApiProperty({ type: String, format: 'uuid', nullable: true })
  cardId: string | null;

  @ApiProperty({ type: String, format: 'uuid', nullable: true })
  chatId: string | null;

  @ApiProperty({ enum: TransactionType, example: TransactionType.PAYMENT })
  type: TransactionType;

  @ApiProperty({ enum: TransactionStatus, example: TransactionStatus.SUCCESS })
  status: TransactionStatus;

  @ApiProperty({ enum: ApprovalStatus, example: ApprovalStatus.APPROVED })
  approvalStatus: ApprovalStatus;

  @ApiProperty({ example: '2500.00', description: 'Fixed 2-decimal string' })
  amount: string;

  @ApiProperty({ example: 'NGN' })
  currency: string;

  @ApiProperty({ type: String, nullable: true, example: 'Lunch with Amina' })
  description: string | null;

  @ApiProperty({ type: Object, additionalProperties: true, nullable: true })
  metadata: Record<string, unknown> | null;

  @ApiProperty({ enum: TransactionFrequency, example: TransactionFrequency.ONE_TIME })
  frequency: TransactionFrequency;

  @ApiProperty({ example: false })
  isRecurring: boolean;

  @ApiProperty({ type: String, format: 'date-time', nullable: true })
  recurrenceEndDate: Date | null;

  @ApiProperty({ type: String, format: 'date-time', nullable: true })
  nextOccurrenceDate: Date | null;

  @ApiProperty({ example: false })
  thresholdWarning: boolean;

  @ApiProperty({ type: String, nullable: true })
  approvalNotes: string | null;

  @ApiProperty({ type: String, format: 'date-time', nullable: true })
  approvedAt: Date | null;

  @ApiProperty({ type: String, format: 'date-time' })
  createdAt: Date;

  @ApiProperty({ type: String, format: 'date-time' })
  updatedAt: Date;
}

/** Paged envelope for `GET /api/transactions`. */
export class PagedTransactionsDto {
  @ApiProperty({ type: [TransactionDto] })
  items: TransactionDto[];

  @ApiProperty({ example: 42 })
  total: number;

  @ApiProperty({ example: 1 })
  page: number;

  @ApiProperty({ example: 20 })
  pageSize: number;

  @ApiProperty({ example: 3 })
  totalPages: number;
}

/** Query parameters for `GET /api/approvals`. */
export class ListApprovalsQueryDto {
  @ApiPropertyOptional({
    example: 'lunch',
    description: 'Free-text search across the approval notes and transaction description',
  })
  @IsOptional()
  @IsString()
  @MaxLength(100)
  q?: string;

  @ApiPropertyOptional({
    example: 'status:PENDING',
    description:
      'Repeatable `field:value` (equality on enums/numbers) or `field:op:value` filters (`status`)',
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

/** The card used by an approval's transaction — the PAN is never exposed. */
export class ApprovalCardDto {
  @ApiProperty({ format: 'uuid', example: '673bc257-9204-4acb-acf5-61f51e20a328' })
  id: string;

  @ApiProperty({ example: '4242', description: 'Last 4 digits, shown for verification' })
  cardNumberLast4: string;

  @ApiProperty({ example: 'virtual' })
  cardType: string;

  @ApiProperty({ type: String, format: 'date-time' })
  createdAt: Date;

  @ApiProperty({ example: '2500.00', description: 'Cumulative spend via this card' })
  totalSpent: string;
}

/** An approval decision on one of the user's transactions. */
export class ApprovalDto {
  @ApiProperty({ format: 'uuid', example: '673bc257-9204-4acb-acf5-61f51e20a328' })
  id: string;

  @ApiProperty({ format: 'uuid', example: '673bc257-9204-4acb-acf5-61f51e20a328' })
  transactionId: string;

  @ApiProperty({ enum: ApprovalStatus, example: ApprovalStatus.PENDING })
  status: ApprovalStatus;

  @ApiProperty({ format: 'uuid', example: '673bc257-9204-4acb-acf5-61f51e20a328' })
  approvedBy: string;

  @ApiProperty({ type: String, nullable: true })
  notes: string | null;

  @ApiProperty({ type: String, format: 'date-time' })
  createdAt: Date;

  @ApiProperty({ type: TransactionDto })
  transaction: TransactionDto;

  @ApiProperty({
    type: ApprovalCardDto,
    nullable: true,
    description: 'The card used for the transaction, if any',
  })
  card: ApprovalCardDto | null;
}

/** Paged envelope for `GET /api/approvals`. */
export class PagedApprovalsDto {
  @ApiProperty({ type: [ApprovalDto] })
  items: ApprovalDto[];

  @ApiProperty({ example: 5 })
  total: number;

  @ApiProperty({ example: 1 })
  page: number;

  @ApiProperty({ example: 20 })
  pageSize: number;

  @ApiProperty({ example: 1 })
  totalPages: number;
}
