import { ApiProperty } from '@nestjs/swagger';
import { OtpChannel } from '@prisma/client';
import { IsIn, IsString, Length, Matches } from 'class-validator';

/** Request body for `POST /api/otp/send`. */
export class SendOtpDto {
  @ApiProperty({ enum: OtpChannel, example: OtpChannel.PHONE })
  @IsIn(Object.values(OtpChannel))
  channel: OtpChannel;

  @ApiProperty({ example: '+2348000000000', description: 'Must be your own email or phone' })
  @IsString()
  @Length(3, 254)
  target: string;
}

/** Request body for `POST /api/otp/verify`. */
export class VerifyOtpDto {
  @ApiProperty({ enum: OtpChannel, example: OtpChannel.PHONE })
  @IsIn(Object.values(OtpChannel))
  channel: OtpChannel;

  @ApiProperty({ example: '+2348000000000', description: 'Must be your own email or phone' })
  @IsString()
  @Length(3, 254)
  target: string;

  @ApiProperty({ example: '481516', description: '6-digit code' })
  @IsString()
  @Length(6, 6)
  @Matches(/^[0-9]{6}$/, { message: 'code must be 6 digits' })
  code: string;
}

/** Response for `POST /api/otp/send` — the code itself is never returned. */
export class SendOtpResponseDto {
  @ApiProperty({ example: 'sent' })
  status: 'sent';
}

/** Response for `POST /api/otp/verify`. */
export class VerifyOtpResponseDto {
  @ApiProperty({ example: true })
  verified: true;
}
