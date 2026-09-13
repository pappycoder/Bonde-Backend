import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { NotificationStatus, NotificationType } from '@prisma/client';
import { Type } from 'class-transformer';
import { IsInt, IsOptional, IsString, Max, MaxLength, Min } from 'class-validator';

/** Query parameters for `GET /api/notifications`. */
export class ListNotificationsQueryDto {
  @ApiPropertyOptional({
    example: 'card',
    description: 'Free-text search across the notification title and content',
  })
  @IsOptional()
  @IsString()
  @MaxLength(100)
  q?: string;

  @ApiPropertyOptional({
    example: 'status:UNREAD',
    description: 'Repeatable `field:value` or `field:op:value` filters (`status`, `type`)',
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

/** A notification as returned to the owning user. */
export class NotificationDto {
  @ApiProperty({ format: 'uuid', example: '673bc257-9204-4acb-acf5-61f51e20a328' })
  id: string;

  @ApiProperty({ format: 'uuid', example: '673bc257-9204-4acb-acf5-61f51e20a328' })
  userId: string;

  @ApiProperty({ example: 'Card shutdown' })
  title: string;

  @ApiProperty({ example: 'Your card was paused for your protection.' })
  content: string;

  @ApiProperty({ enum: NotificationStatus, example: NotificationStatus.UNREAD })
  status: NotificationStatus;

  @ApiProperty({ enum: NotificationType, example: NotificationType.CARD })
  type: NotificationType;

  @ApiProperty({ type: Object, additionalProperties: true, nullable: true })
  metadata: Record<string, unknown> | null;

  @ApiProperty({ type: String, format: 'date-time', nullable: true })
  readAt: Date | null;

  @ApiProperty({ type: String, format: 'date-time' })
  createdAt: Date;
}

/** Paged envelope for `GET /api/notifications`. */
export class PagedNotificationsDto {
  @ApiProperty({ type: [NotificationDto] })
  items: NotificationDto[];

  @ApiProperty({ example: 42 })
  total: number;

  @ApiProperty({ example: 1 })
  page: number;

  @ApiProperty({ example: 20 })
  pageSize: number;

  @ApiProperty({ example: 3 })
  totalPages: number;
}

/** Response for `PATCH /api/notifications/read-all`. */
export class MarkAllReadResponseDto {
  @ApiProperty({ example: 7 })
  updated: number;
}
