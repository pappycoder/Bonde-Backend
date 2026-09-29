import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { Type } from 'class-transformer';
import {
  IsIn,
  IsInt,
  IsNotEmpty,
  IsOptional,
  IsString,
  IsUUID,
  Max,
  MaxLength,
  Min,
} from 'class-validator';

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
// Write-model DTOs (Phase 3 admin actions)
// ---------------------------------------------------------------------------

/** Body for `POST /api/admin/users/:id/suspend` (restore ignores the body). */
export class SuspendUserBodyDto {
  @ApiPropertyOptional({
    example: 'Repeatedly failed risk review',
    maxLength: 300,
  })
  @IsOptional()
  @IsString()
  @MaxLength(300)
  reason?: string;
}

/** Body for `POST /api/admin/transactions/:id/approval`. */
export class ReviewApprovalBodyDto {
  @ApiProperty({ enum: ['APPROVED', 'DECLINED'] })
  @IsIn(['APPROVED', 'DECLINED'])
  status: 'APPROVED' | 'DECLINED';

  @ApiPropertyOptional({
    example: 'Provider confirms the payout is legitimate.',
    maxLength: 500,
  })
  @IsOptional()
  @IsString()
  @MaxLength(500)
  notes?: string;
}

// ---------------------------------------------------------------------------
// Write-model DTOs (Phase 5 support tickets)
// ---------------------------------------------------------------------------

/** Query parameters for `GET /api/admin/transactions`. */
export class AdminTransactionListQueryDto extends AdminListQueryDto {
  /**
   * The UI-legible status the list renders, rather than the raw
   * `status`/`approvalStatus`/`thresholdWarning` triple behind it. Filtering on
   * the raw triple cannot express the derived values, and the two vocabularies
   * disagree, so this is the filter that matches what the table shows.
   */
  @ApiPropertyOptional({ enum: ['completed', 'processing', 'pending', 'failed', 'flagged'] })
  @IsOptional()
  @IsIn(['completed', 'processing', 'pending', 'failed', 'flagged'])
  uiStatus?: 'completed' | 'processing' | 'pending' | 'failed' | 'flagged';
}

/** Query parameters for `GET /api/admin/support-tickets`. */
export class AdminSupportListQueryDto extends AdminListQueryDto {
  @ApiPropertyOptional({ enum: ['OPEN', 'PENDING', 'RESOLVED'] })
  @IsOptional()
  @IsIn(['OPEN', 'PENDING', 'RESOLVED'])
  status?: 'OPEN' | 'PENDING' | 'RESOLVED';
}

/** Body for `POST /api/admin/support-tickets` (admin raises a ticket for a user). */
export class CreateSupportTicketBodyDto {
  @ApiProperty({ format: 'uuid' })
  @IsUUID()
  userId: string;

  @ApiProperty({ example: 'Withdrawal blocked — account under review', maxLength: 255 })
  @IsNotEmpty()
  @IsString()
  @MaxLength(255)
  subject: string;

  @ApiPropertyOptional({ enum: ['LOW', 'MEDIUM', 'HIGH', 'URGENT'] })
  @IsOptional()
  @IsIn(['LOW', 'MEDIUM', 'HIGH', 'URGENT'])
  priority?: 'LOW' | 'MEDIUM' | 'HIGH' | 'URGENT';

  @ApiPropertyOptional({
    example: 'Opened on the user’s behalf after their call.',
    maxLength: 4000,
  })
  @IsOptional()
  @IsString()
  @MaxLength(4000)
  message?: string;
}

/** Body for `PATCH /api/admin/support-tickets/:id/status`. */
export class UpdateSupportTicketStatusBodyDto {
  @ApiProperty({ enum: ['OPEN', 'PENDING', 'RESOLVED'] })
  @IsIn(['OPEN', 'PENDING', 'RESOLVED'])
  status: 'OPEN' | 'PENDING' | 'RESOLVED';
}

/** Body for `POST /api/admin/support-tickets/:id/messages` (support reply). */
export class NewSupportTicketMessageBodyDto {
  @ApiProperty({ example: 'Thanks — we are looking into this now.', maxLength: 4000 })
  @IsNotEmpty()
  @IsString()
  @MaxLength(4000)
  body: string;
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

class AdminStatsTotalsDto {
  @ApiProperty({ example: 128 })
  users: number;

  @ApiProperty({ example: 96 })
  activeUsers: number;

  @ApiProperty({ example: 24 })
  pendingUsers: number;

  @ApiProperty({ example: 8 })
  suspendedUsers: number;

  @ApiProperty({ example: 12 })
  newUsers30d: number;

  @ApiProperty({ example: 9 })
  newUsersPrev30d: number;

  @ApiProperty({ example: 340 })
  transactions30d: number;

  @ApiProperty({ example: '250000.00' })
  volume: string;

  @ApiProperty({ example: '84000.00' })
  volume30d: string;

  @ApiProperty({ example: '62000.00' })
  volumePrev30d: string;

  @ApiProperty({ example: '60000.00' })
  deposits30d: string;

  @ApiProperty({ example: '45000.00' })
  depositsPrev30d: string;

  @ApiProperty({ example: 4 })
  pendingReviews: number;

  @ApiProperty({ example: 3 })
  openTickets: number;
}

class AdminStatsRevenuePointDto {
  @ApiProperty({ example: 'Oct' })
  month: string;

  @ApiProperty({ example: '21250.00' })
  revenue: string;

  @ApiProperty({ example: '9800.00' })
  expenses: string;

  @ApiProperty({ example: '19000.00' })
  volume: string;
}

class AdminStatsWeeklyPointDto {
  @ApiProperty({ example: 'Mon' })
  day: string;

  @ApiProperty({ example: 14 })
  transactions: number;
}

export class AdminStatsResponseDto {
  @ApiProperty({ type: AdminStatsTotalsDto })
  totals: AdminStatsTotalsDto;

  @ApiProperty({ type: AdminStatsRevenuePointDto, isArray: true })
  revenue: AdminStatsRevenuePointDto[];

  @ApiProperty({ type: AdminStatsWeeklyPointDto, isArray: true })
  weekly: AdminStatsWeeklyPointDto[];
}

class AdminSupportTicketViewDto {
  @ApiProperty({ format: 'uuid' })
  id: string;

  @ApiProperty({ format: 'uuid' })
  userId: string;

  @ApiProperty({ nullable: true, example: 'Olivia Martin' })
  user: string | null;

  @ApiProperty({ nullable: true, example: 'olivia@bonde.ai' })
  userEmail: string | null;

  @ApiProperty({ example: 'Withdrawal blocked — account under review' })
  subject: string;

  @ApiProperty({ enum: ['LOW', 'MEDIUM', 'HIGH', 'URGENT'] })
  priority: 'LOW' | 'MEDIUM' | 'HIGH' | 'URGENT';

  @ApiProperty({ enum: ['OPEN', 'PENDING', 'RESOLVED'] })
  status: 'OPEN' | 'PENDING' | 'RESOLVED';

  @ApiProperty({ nullable: true, example: 'T. Reed' })
  assignee: string | null;

  @ApiProperty({ example: 4 })
  messageCount: number;

  @ApiProperty({ example: '2026-09-08T09:42:00.000Z' })
  createdAt: string;

  @ApiProperty({ example: '2026-09-08T09:42:00.000Z' })
  updatedAt: string;
}

class AdminSupportMessageDto {
  @ApiProperty({ format: 'uuid' })
  id: string;

  @ApiProperty({ enum: ['USER', 'SUPPORT'] })
  role: 'USER' | 'SUPPORT';

  @ApiProperty({ example: 'Thanks — we are looking into this now.' })
  body: string;

  @ApiProperty({ example: '2026-09-08T09:42:00.000Z' })
  createdAt: string;
}

export class AdminSupportTicketDetailDto extends AdminSupportTicketViewDto {
  @ApiProperty({ type: AdminSupportMessageDto, isArray: true })
  messages: AdminSupportMessageDto[];
}

export class PagedAdminSupportTicketsResponseDto {
  @ApiProperty({ type: AdminSupportTicketViewDto, isArray: true })
  items: AdminSupportTicketViewDto[];

  @ApiProperty(PAGED_DTO_FIELDS.total)
  total: number;

  @ApiProperty(PAGED_DTO_FIELDS.page)
  page: number;

  @ApiProperty(PAGED_DTO_FIELDS.pageSize)
  pageSize: number;

  @ApiProperty(PAGED_DTO_FIELDS.totalPages)
  totalPages: number;
}
