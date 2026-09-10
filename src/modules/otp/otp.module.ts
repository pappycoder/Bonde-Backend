import { Module } from '@nestjs/common';
import { OtpController } from './otp.controller.js';
import { OtpService } from './otp.service.js';
import { RoutingOtpSender } from './otp-sender.routing.js';
import { ResendOtpSender } from './resend-otp.sender.js';
import { TermiiOtpSender } from './termii-otp.sender.js';
import { OTP_SENDER } from './otp-sender.interface.js';

@Module({
  controllers: [OtpController],
  providers: [
    OtpService,
    TermiiOtpSender,
    ResendOtpSender,
    RoutingOtpSender,
    {
      provide: OTP_SENDER,
      useExisting: RoutingOtpSender,
    },
  ],
  exports: [OtpService, OTP_SENDER],
})
export class OtpModule {}
