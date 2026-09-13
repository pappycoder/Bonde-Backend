import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { Type } from 'class-transformer';
import { IsInt, IsOptional, IsString, Max, Min } from 'class-validator';

/** Query parameters for `GET /api/admin/:resource`. */
export class CrudListQueryDto {
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

  /** Repeatable: `?filter=status:UNREAD&filter=userId:<uuid>`. Field equality, or `field:op:value`. */
  @ApiPropertyOptional({
    example: 'status:UNREAD',
    description:
      'Repeatable `field:value` or `field:op:value` filters. Operators: eq (default), contains, startsWith, endsWith, gt, gte, lt, lte.',
  })
  @IsOptional()
  filter?: string | string[];

  @ApiPropertyOptional({
    example: 'lunch',
    description: 'Free-text search across the searchable string fields of the resource',
  })
  @IsOptional()
  @IsString()
  q?: string;

  @ApiPropertyOptional({
    example: 'createdAt:desc',
    description: 'Visible field + `:asc` or `:desc`',
  })
  @IsOptional()
  @IsString()
  orderBy?: string;
}

/** Envelope returned by `GET /api/admin/:resource`. */
export class PagedCrudResponseDto {
  @ApiProperty({ type: Object, isArray: true })
  items: Record<string, unknown>[];

  @ApiProperty({ example: 42 })
  total: number;

  @ApiProperty({ example: 1 })
  page: number;

  @ApiProperty({ example: 20 })
  pageSize: number;

  @ApiProperty({ example: 3 })
  totalPages: number;
}

/** Response for `DELETE /api/admin/:resource/:id`. */
export class CrudDeleteResponseDto {
  @ApiProperty({ example: true })
  deleted: true;

  @ApiProperty({ format: 'uuid', example: '673bc257-9204-4acb-acf5-61f51e20a328' })
  id: string;
}
