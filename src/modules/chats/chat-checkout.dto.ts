import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { IsIn, IsOptional, IsUUID } from 'class-validator';

export class StartChatCheckoutDto {
  @ApiProperty({ enum: ['ONE_TIME', 'EXISTING'] })
  @IsIn(['ONE_TIME', 'EXISTING'])
  method: 'ONE_TIME' | 'EXISTING';
  @ApiPropertyOptional({ format: 'uuid' })
  @IsOptional()
  @IsUUID('4')
  cardId?: string;
}
export class ChatCheckoutDto {
  transactionId: string;
  @ApiProperty({ enum: ['PREPARING', 'PROCESSING', 'SUCCESS', 'FAILED', 'CANCELLED'] })
  status: 'PREPARING' | 'PROCESSING' | 'SUCCESS' | 'FAILED' | 'CANCELLED';
  @ApiProperty({ enum: ['ONE_TIME', 'EXISTING'] })
  method: 'ONE_TIME' | 'EXISTING';
  cardId?: string;
  cardLast4?: string;
  oneTimeClosed?: boolean;
  reference?: string;
  completedAt?: string;
  amount: string;
  currency: string;
  merchant: string;
}
