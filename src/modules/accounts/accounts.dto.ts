import { ApiProperty } from '@nestjs/swagger';
import { AccountType } from '@prisma/client';

/** A user's single bank account, returned to the owning user. */
export class AccountDto {
  @ApiProperty({ format: 'uuid', example: '673bc257-9204-4acb-acf5-61f51e20a328' })
  id: string;

  @ApiProperty({ format: 'uuid', example: '673bc257-9204-4acb-acf5-61f51e20a328' })
  userId: string;

  @ApiProperty({ example: '0123456789' })
  accountNumber: string;

  @ApiProperty({ enum: AccountType, example: AccountType.CHECKING })
  accountType: AccountType;

  @ApiProperty({ example: true })
  isActive: boolean;

  @ApiProperty({ type: String, format: 'date-time' })
  createdAt: Date;

  @ApiProperty({ type: String, format: 'date-time' })
  updatedAt: Date;
}
