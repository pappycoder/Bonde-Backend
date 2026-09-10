import type { OtpChannel } from '@prisma/client';

/**
 * Delivery boundary for one-time codes. The OTP service only talks to this
 * interface — production routing (Termii for SMS, Resend for email) happens
 * behind the `OTP_SENDER` token, and tests stub the token to capture codes.
 * Implementations must fail closed: any delivery failure throws `OtpSendError`.
 */
export interface OtpSendRequest {
  channel: OtpChannel;
  target: string;
  code: string;
}

export interface OtpSender {
  send(request: OtpSendRequest): Promise<void>;
}

/** Internal token marking a delivery failure (mapped to a 503 by OtpService). */
export class OtpSendError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'OtpSendError';
  }
}

export const OTP_SENDER = Symbol('OTP_SENDER');
