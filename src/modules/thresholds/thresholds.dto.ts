import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { ThresholdType } from '@prisma/client';
import { Type } from 'class-transformer';
import {
  IsBoolean,
  IsIn,
  IsInt,
  IsOptional,
  IsString,
  Matches,
  Max,
  MaxLength,
  Min,
} from 'class-validator';

const DECIMAL_PATTERN = /^\d+(\.\d{1,2})?$/;

/** Query parameters for `GET /api/thresholds`. */
export class ListThresholdsQueryDto {
  @ApiPropertyOptional({
    example: 'large',
    description: 'Not supported on thresholds — passes `q` returns 400',
  })
  @IsOptional()
  @IsString()
  @MaxLength(100)
  q?: string;

  @ApiPropertyOptional({
    example: 'isActive:true',
    description:
      'Repeatable `field:value` or `field:op:value` filters (`thresholdType`, `isActive`)',
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

/** Body for `POST /api/thresholds` (one per type). */
export class CreateThresholdDto {
  @ApiProperty({ enum: ThresholdType, example: ThresholdType.LARGE_AMOUNT })
  @IsIn(Object.values(ThresholdType))
  thresholdType: ThresholdType;

  @ApiProperty({ example: '5000.00' })
  @Matches(DECIMAL_PATTERN, { message: 'thresholdValue must be a decimal with up to 2 places' })
  thresholdValue: string;

  @ApiPropertyOptional({ example: true })
  @IsOptional()
  @IsBoolean()
  isActive?: boolean;
}

/** Body for `PATCH /api/thresholds/:id`. */
export class UpdateThresholdDto {
  @ApiPropertyOptional({ example: '7500.00' })
  @IsOptional()
  @Matches(DECIMAL_PATTERN, { message: 'thresholdValue must be a decimal with up to 2 places' })
  thresholdValue?: string;

  @ApiPropertyOptional({ example: false })
  @IsOptional()
  @IsBoolean()
  isActive?: boolean;
}

/** A user-configured transaction warning threshold. */
export class ThresholdDto {
  @ApiProperty({ format: 'uuid', example: '673bc257-9204-4acb-acf5-61f51e20a328' })
  id: string;

  @ApiProperty({ format: 'uuid', example: '673bc257-9204-4acb-acf5-61f51e20a328' })
  userId: string;

  @ApiProperty({ enum: ThresholdType, example: ThresholdType.LARGE_AMOUNT })
  thresholdType: ThresholdType;

  @ApiProperty({ example: '5000.00', description: 'Fixed 2-decimal string' })
  thresholdValue: string;

  @ApiProperty({ example: true })
  isActive: boolean;

  @ApiProperty({ type: String, format: 'date-time' })
  createdAt: Date;

  @ApiProperty({ type: String, format: 'date-time' })
  updatedAt: Date;
}

/** Paged envelope for `GET /api/thresholds`. */
export class PagedThresholdsDto {
  @ApiProperty({ type: [ThresholdDto] })
  items: ThresholdDto[];

  @ApiProperty({ example: 2 })
  total: number;

  @ApiProperty({ example: 1 })
  page: number;

  @ApiProperty({ example: 20 })
  pageSize: number;

  @ApiProperty({ example: 1 })
  totalPages: number;
}

/** Response for `DELETE /api/thresholds/:id`. */
export class ThresholdsDeleteResponseDto {
  @ApiProperty({ example: true })
  deleted: true;

  @ApiProperty({ format: 'uuid', example: '673bc257-9204-4acb-acf5-61f51e20a328' })
  id: string;
}
