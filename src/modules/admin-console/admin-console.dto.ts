import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { Type } from 'class-transformer';
import { IsIn, IsInt, IsOptional, IsString, Max, Min } from 'class-validator';

/** Query parameters for the admin console list endpoints. */
export class AdminListQueryDto {
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

  @ApiPropertyOptional({ example: 'olivia' })
  @IsOptional()
  @IsString()
  q?: string;

  /** Repeatable: `?filter=field:value`. */
  @ApiPropertyOptional({ example: 'emailVerified:true' })
  @IsOptional()
  filter?: string | string[];
}

/** Query parameters for `GET /api/admin/users`. */
export class AdminUserListQueryDto extends AdminListQueryDto {
  @ApiPropertyOptional({
    enum: ['active', 'pending', 'suspended'],
    description: 'Derived user status (mapped to the underlying profile/account/wallet state)',
  })
  @IsOptional()
  @IsIn(['active', 'pending', 'suspended'])
  status?: 'active' | 'pending' | 'suspended';
}

// ---------------------------------------------------------------------------
// Read-model DTOs (Swagger response models)
// ---------------------------------------------------------------------------

class AdminUserViewDto {
  @ApiProperty({ format: 'uuid' })
  id: string;

  @ApiProperty({ example: 'Olivia Martin' })
  fullName: string;

  @ApiProperty({ example: 'olivia@bonde.ai' })
  email: string;

  @ApiProperty({ nullable: true })
  phone: string | null;

  @ApiProperty({ nullable: true })
  avatarUrl: string | null;

  @ApiProperty()
  emailVerified: boolean;

  @ApiProperty()
  phoneVerified: boolean;

  @ApiProperty()
  onboardingCompleted: boolean;

  @ApiProperty({ enum: ['active', 'pending', 'suspended'] })
  status: 'active' | 'pending' | 'suspended';

  @ApiProperty({ example: '2500.00' })
  balance: string;

  @ApiProperty({ example: 'NGN' })
  currency: string;

  @ApiProperty({ nullable: true })
  accountNumber: string | null;

  @ApiProperty({ nullable: true, example: 'CHECKING' })
  accountType: string | null;

  @ApiProperty()
  isActive: boolean;

  @ApiProperty({ example: '2026-08-01T09:00:00.000Z' })
  joinedAt: string;

  @ApiProperty({ example: '2026-09-08T09:42:00.000Z' })
  lastActiveAt: string;

  @ApiProperty({ example: 12 })
  transactionCount: number;
}

class AdminTxSummaryViewDto {
  @ApiProperty({ format: 'uuid' })
  id: string;

  @ApiProperty({ format: 'uuid' })
  userId: string;

  @ApiProperty({ enum: ['deposit', 'withdrawal', 'transfer', 'payment'] })
  type: 'deposit' | 'withdrawal' | 'transfer' | 'payment';

  @ApiProperty({ enum: ['completed', 'processing', 'pending', 'failed', 'flagged'] })
  status: 'completed' | 'processing' | 'pending' | 'failed' | 'flagged';

  @ApiProperty({ enum: ['PENDING', 'APPROVED', 'DECLINED'] })
  approvalStatus: 'PENDING' | 'APPROVED' | 'DECLINED';

  @ApiProperty({ example: '2500.00' })
  amount: string;

  @ApiProperty({ example: 'NGN' })
  currency: string;

  @ApiProperty({ example: 'Bank transfer' })
  method: string;

  @ApiProperty({ nullable: true })
  description: string | null;

  @ApiProperty()
  thresholdWarning: boolean;

  @ApiProperty()
  isRecurring: boolean;

  @ApiProperty({ example: '2026-09-08T09:42:00.000Z' })
  createdAt: string;
}

class AdminTransactionViewDto extends AdminTxSummaryViewDto {
  @ApiProperty({ nullable: true, example: 'Olivia Martin' })
  user: string | null;

  @ApiProperty({ nullable: true })
  userEmail: string | null;
}

export const PAGED_DTO_FIELDS = {
  total: { example: 42 },
  page: { example: 1 },
  pageSize: { example: 20 },
  totalPages: { example: 3 },
} as const;

export class PagedAdminUsersResponseDto {
  @ApiProperty({ type: AdminUserViewDto, isArray: true })
  items: AdminUserViewDto[];

  @ApiProperty(PAGED_DTO_FIELDS.total)
  total: number;

  @ApiProperty(PAGED_DTO_FIELDS.page)
  page: number;

  @ApiProperty(PAGED_DTO_FIELDS.pageSize)
  pageSize: number;

  @ApiProperty(PAGED_DTO_FIELDS.totalPages)
  totalPages: number;
}

export class PagedAdminTransactionsResponseDto {
  @ApiProperty({ type: AdminTransactionViewDto, isArray: true })
  items: AdminTransactionViewDto[];

  @ApiProperty(PAGED_DTO_FIELDS.total)
  total: number;

  @ApiProperty(PAGED_DTO_FIELDS.page)
  page: number;

  @ApiProperty(PAGED_DTO_FIELDS.pageSize)
  pageSize: number;

  @ApiProperty(PAGED_DTO_FIELDS.totalPages)
  totalPages: number;
}
