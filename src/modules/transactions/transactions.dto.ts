import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import {
  ApprovalStatus,
  TransactionFrequency,
  TransactionStatus,
  TransactionType,
} from '@prisma/client';
import { Type } from 'class-transformer';
import {
  IsBoolean,
  IsDateString,
  IsIn,
  IsInt,
  IsObject,
  IsOptional,
  IsString,
  IsUUID,
  Matches,
  Max,
  MaxLength,
  Min,
} from 'class-validator';

const DECIMAL_PATTERN = /^\d+(\.\d{1,2})?$/;
const CURRENCY_PATTERN = /^[A-Z]{3}$/;

/** Query parameters for `GET /api/transactions`. */
export class ListTransactionsQueryDto {
  @ApiPropertyOptional({ enum: TransactionStatus, example: TransactionStatus.SUCCESS })
  @IsOptional()
  @IsIn(Object.values(TransactionStatus))
  status?: TransactionStatus;

  @ApiPropertyOptional({ enum: TransactionType, example: TransactionType.PAYMENT })
  @IsOptional()
  @IsIn(Object.values(TransactionType))
  type?: TransactionType;

  @ApiPropertyOptional({ enum: ApprovalStatus, example: ApprovalStatus.PENDING })
  @IsOptional()
  @IsIn(Object.values(ApprovalStatus))
  approvalStatus?: ApprovalStatus;

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
  @ApiPropertyOptional({ enum: ApprovalStatus, example: ApprovalStatus.PENDING })
  @IsOptional()
  @IsIn(Object.values(ApprovalStatus))
  status?: ApprovalStatus;

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

/** Body for `POST /api/transactions`. */
export class CreateTransactionDto {
  @ApiProperty({ format: 'uuid', example: '673bc257-9204-4acb-acf5-61f51e20a328' })
  @IsUUID('4')
  walletId: string;

  @ApiProperty({ enum: TransactionType, example: TransactionType.PAYMENT })
  @IsIn(Object.values(TransactionType))
  type: TransactionType;

  @ApiProperty({ example: '2500.00' })
  @Matches(DECIMAL_PATTERN, { message: 'amount must be a decimal with up to 2 places' })
  amount: string;

  @ApiPropertyOptional({ enum: TransactionStatus, example: TransactionStatus.PENDING })
  @IsOptional()
  @IsIn(Object.values(TransactionStatus))
  status?: TransactionStatus;

  @ApiPropertyOptional({ enum: ApprovalStatus, example: ApprovalStatus.PENDING })
  @IsOptional()
  @IsIn(Object.values(ApprovalStatus))
  approvalStatus?: ApprovalStatus;

  @ApiPropertyOptional({ example: 'NGN' })
  @IsOptional()
  @Matches(CURRENCY_PATTERN, { message: 'currency must be a 3-letter code' })
  currency?: string;

  @ApiPropertyOptional({ type: String, format: 'uuid' })
  @IsOptional()
  @IsUUID('4')
  cardId?: string;

  @ApiPropertyOptional({ type: String, format: 'uuid' })
  @IsOptional()
  @IsUUID('4')
  chatId?: string;

  @ApiPropertyOptional({ type: String, example: 'Lunch with Amina' })
  @IsOptional()
  @IsString()
  @MaxLength(500)
  description?: string;

  @ApiPropertyOptional({ type: Object, additionalProperties: true })
  @IsOptional()
  @IsObject()
  metadata?: Record<string, unknown>;

  @ApiPropertyOptional({ enum: TransactionFrequency, example: TransactionFrequency.ONE_TIME })
  @IsOptional()
  @IsIn(Object.values(TransactionFrequency))
  frequency?: TransactionFrequency;

  @ApiPropertyOptional({ example: false })
  @IsOptional()
  @IsBoolean()
  isRecurring?: boolean;

  @ApiPropertyOptional({ type: String, format: 'date-time' })
  @IsOptional()
  @IsDateString()
  recurrenceEndDate?: string;

  @ApiPropertyOptional({ type: String, format: 'date-time' })
  @IsOptional()
  @IsDateString()
  nextOccurrenceDate?: string;

  @ApiPropertyOptional({ type: String })
  @IsOptional()
  @IsString()
  @MaxLength(500)
  approvalNotes?: string;
}

/** Body for `PATCH /api/transactions/:id`. */
export class UpdateTransactionDto {
  @ApiPropertyOptional({ enum: TransactionStatus, example: TransactionStatus.SUCCESS })
  @IsOptional()
  @IsIn(Object.values(TransactionStatus))
  status?: TransactionStatus;

  @ApiPropertyOptional({ enum: ApprovalStatus, example: ApprovalStatus.APPROVED })
  @IsOptional()
  @IsIn(Object.values(ApprovalStatus))
  approvalStatus?: ApprovalStatus;

  @ApiPropertyOptional({ example: '2500.00' })
  @IsOptional()
  @Matches(DECIMAL_PATTERN, { message: 'amount must be a decimal with up to 2 places' })
  amount?: string;

  @ApiPropertyOptional({ example: 'NGN' })
  @IsOptional()
  @Matches(CURRENCY_PATTERN, { message: 'currency must be a 3-letter code' })
  currency?: string;

  @ApiPropertyOptional({ type: String })
  @IsOptional()
  @IsString()
  @MaxLength(500)
  description?: string;

  @ApiPropertyOptional({ type: Object, additionalProperties: true })
  @IsOptional()
  @IsObject()
  metadata?: Record<string, unknown>;

  @ApiPropertyOptional({ enum: TransactionFrequency, example: TransactionFrequency.MONTHLY })
  @IsOptional()
  @IsIn(Object.values(TransactionFrequency))
  frequency?: TransactionFrequency;

  @ApiPropertyOptional({ example: false })
  @IsOptional()
  @IsBoolean()
  isRecurring?: boolean;

  @ApiPropertyOptional({ type: String, format: 'date-time' })
  @IsOptional()
  @IsDateString()
  recurrenceEndDate?: string;

  @ApiPropertyOptional({ type: String, format: 'date-time' })
  @IsOptional()
  @IsDateString()
  nextOccurrenceDate?: string;

  @ApiPropertyOptional({ type: String })
  @IsOptional()
  @IsString()
  @MaxLength(500)
  approvalNotes?: string;

  @ApiPropertyOptional({ example: false })
  @IsOptional()
  @IsBoolean()
  thresholdWarning?: boolean;
}

/** Response for `DELETE /api/transactions/:id`. */
export class TransactionsDeleteResponseDto {
  @ApiProperty({ example: true })
  deleted: true;

  @ApiProperty({ format: 'uuid', example: '673bc257-9204-4acb-acf5-61f51e20a328' })
  id: string;
}

/** Body for `POST /api/approvals`. */
export class CreateApprovalDto {
  @ApiProperty({ format: 'uuid', example: '673bc257-9204-4acb-acf5-61f51e20a328' })
  @IsUUID('4')
  transactionId: string;

  @ApiPropertyOptional({ enum: ApprovalStatus, example: ApprovalStatus.PENDING })
  @IsOptional()
  @IsIn(Object.values(ApprovalStatus))
  status?: ApprovalStatus;

  @ApiPropertyOptional({ type: String })
  @IsOptional()
  @IsString()
  @MaxLength(500)
  notes?: string;
}

/** Body for `PATCH /api/approvals/:id`. */
export class UpdateApprovalDto {
  @ApiPropertyOptional({ enum: ApprovalStatus, example: ApprovalStatus.APPROVED })
  @IsOptional()
  @IsIn(Object.values(ApprovalStatus))
  status?: ApprovalStatus;

  @ApiPropertyOptional({ type: String })
  @IsOptional()
  @IsString()
  @MaxLength(500)
  notes?: string;
}

/** Response for `DELETE /api/approvals/:id`. */
export class ApprovalsDeleteResponseDto {
  @ApiProperty({ example: true })
  deleted: true;

  @ApiProperty({ format: 'uuid', example: '673bc257-9204-4acb-acf5-61f51e20a328' })
  id: string;
}
