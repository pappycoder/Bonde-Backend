import { Injectable } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import type { AppConfig } from '../../config/configuration.js';
import { OtpSendError, type OtpSendRequest, type OtpSender } from './otp-sender.interface.js';

const RESEND_BASE_URL = 'https://api.resend.com';
const SEND_TIMEOUT_MS = 10_000;

/**
 * Email delivery via Resend. Fails closed: network errors and non-2xx
 * responses become `OtpSendError` (never swallowed).
 */
@Injectable()
export class ResendOtpSender implements OtpSender {
  private readonly apiKey: string;
  private readonly fromEmail: string;

  constructor(config: ConfigService<AppConfig, true>) {
    const resend = config.get('resend');
    this.apiKey = resend.apiKey;
    this.fromEmail = resend.fromEmail;
  }

  async send(request: OtpSendRequest): Promise<void> {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), SEND_TIMEOUT_MS);
    try {
      const response = await globalThis.fetch(`${RESEND_BASE_URL}/emails`, {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${this.apiKey}`,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({
          from: this.fromEmail,
          to: [request.target],
          subject: 'Bonde verification code',
          html: `<p>Your Bonde verification code is <strong>${request.code}</strong>.</p><p>It expires in 5 minutes.</p>`,
        }),
        signal: controller.signal,
      });
      if (!response.ok) {
        throw new OtpSendError(`Resend returned HTTP ${response.status}`);
      }
    } catch (error) {
      if (error instanceof OtpSendError) throw error;
      throw new OtpSendError('Email delivery failed');
    } finally {
      clearTimeout(timer);
    }
  }
}
