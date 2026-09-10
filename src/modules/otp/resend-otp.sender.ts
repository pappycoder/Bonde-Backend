import { Inject, Injectable } from '@nestjs/common';
import { MAIL_SENDER, type MailSender } from '../../common/mail/mail.types.js';
import { verificationCodeEmail } from '../../common/mail/templates/verification-code.js';
import { OtpSendError, type OtpSendRequest, type OtpSender } from './otp-sender.interface.js';

/**
 * Email OTP delivery. Delegates the actual send to the global `MAIL_SENDER`
 * (production: `MailService` → Resend; tests: capture stub) but keeps the
 * OtpSender contract and stays fail-closed — a delivery problem becomes
 * `OtpSendError` so the OTP flow voids the code and answers 503.
 */
@Injectable()
export class ResendOtpSender implements OtpSender {
  constructor(@Inject(MAIL_SENDER) private readonly mail: MailSender) {}

  async send(request: OtpSendRequest): Promise<void> {
    const email = verificationCodeEmail(request.code, 'verify-email');
    try {
      await this.mail.send({ to: request.target, subject: email.subject, html: email.html });
    } catch {
      throw new OtpSendError('Email delivery failed');
    }
  }
}
