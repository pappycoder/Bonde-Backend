import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { Type } from 'class-transformer';
import { IsInt, IsOptional, IsString, Max, MaxLength, Min } from 'class-validator';

/** Query parameters for `GET /api/audit-logs`. */
export class ListAuditLogsQueryDto {
  @ApiPropertyOptional({
    example: 'card.pause',
    description: 'Free-text search across the action and entity type',
  })
  @IsOptional()
  @IsString()
  @MaxLength(100)
  q?: string;

  @ApiPropertyOptional({
    example: 'action:card.pause',
    description:
      'Repeatable `field:value` or `field:op:value` filters. Text fields (action, entityType) partial-match (case-insensitive) by default; use `eq:` for exact match.',
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

/** One audit entry, as returned to the actor who caused it. */
export class AuditLogDto {
  @ApiProperty({ format: 'uuid', example: '673bc257-9204-4acb-acf5-61f51e20a328' })
  id: string;

  @ApiProperty({ format: 'uuid', nullable: true, example: '673bc257-9204-4acb-acf5-61f51e20a328' })
  userId: string | null;

  @ApiProperty({ example: 'card.pause' })
  action: string;

  @ApiProperty({ example: 'card' })
  entityType: string;

  @ApiProperty({ format: 'uuid', example: '673bc257-9204-4acb-acf5-61f51e20a328' })
  entityId: string;

  @ApiProperty({ type: Object, additionalProperties: true, nullable: true })
  metadata: Record<string, unknown> | null;

  @ApiProperty({ type: String, nullable: true })
  ipAddress: string | null;

  @ApiProperty({ type: String, nullable: true })
  userAgent: string | null;

  @ApiProperty({ type: String, format: 'date-time' })
  createdAt: Date;
}

/** Paged envelope for `GET /api/audit-logs`. */
export class PagedAuditLogsDto {
  @ApiProperty({ type: [AuditLogDto] })
  items: AuditLogDto[];

  @ApiProperty({ example: 42 })
  total: number;

  @ApiProperty({ example: 1 })
  page: number;

  @ApiProperty({ example: 20 })
  pageSize: number;

  @ApiProperty({ example: 3 })
  totalPages: number;
}
