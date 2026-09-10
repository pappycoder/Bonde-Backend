/**
 * Delivery boundary for transactional email. Feature code should never talk to
 * Resend directly — it injects the `MAIL_SENDER` token (like `OTP_SENDER` for
 * codes) and calls `send({ to, subject, html })`. Implementations fail closed:
 * any delivery failure throws `MailSendError`.
 */
export interface MailMessage {
  to: string;
  subject: string;
  html: string;
}

export interface MailSender {
  send(message: MailMessage): Promise<void>;
}

/** Internal token marking a delivery failure (mapped by callers, or best-effort). */
export class MailSendError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'MailSendError';
  }
}

export const MAIL_SENDER = Symbol('MAIL_SENDER');
