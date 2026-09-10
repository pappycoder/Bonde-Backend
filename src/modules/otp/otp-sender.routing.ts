import { Injectable } from '@nestjs/common';
import { OtpChannel } from '@prisma/client';
import { ResendOtpSender } from './resend-otp.sender.js';
import { TermiiOtpSender } from './termii-otp.sender.js';
import type { OtpSendRequest, OtpSender } from './otp-sender.interface.js';

/**
 * Routes OTP delivery by channel: SMS (phone) goes to Termii, email to Resend.
 * Bound behind the `OTP_SENDER` token so feature tests can override it with a
 * capturing stub.
 */
@Injectable()
export class RoutingOtpSender implements OtpSender {
  constructor(
    private readonly phone: TermiiOtpSender,
    private readonly email: ResendOtpSender,
  ) {}

  async send(request: OtpSendRequest): Promise<void> {
    const sender = request.channel === OtpChannel.PHONE ? this.phone : this.email;
    return sender.send(request);
  }
}
