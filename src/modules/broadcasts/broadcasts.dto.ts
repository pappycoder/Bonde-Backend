import { Transform, Type } from 'class-transformer';
import { IsInt, IsOptional, IsString, Length, Max, MaxLength, Min } from 'class-validator';

export class SendBroadcastDto {
  @IsString()
  @Length(3, 140)
  @Transform(({ value }) => String(value ?? '').trim())
  title: string;

  @IsString()
  @Length(3, 1000)
  @Transform(({ value }) => String(value ?? '').trim())
  body: string;
}

export class ListBroadcastsQuery {
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  page?: number;

  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  @Max(100)
  pageSize?: number;

  @IsOptional()
  @IsString()
  @MaxLength(140)
  @Transform(({ value }) => String(value ?? '').trim())
  q?: string;
}
