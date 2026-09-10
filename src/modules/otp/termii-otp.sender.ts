import { Injectable } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import type { AppConfig } from '../../config/configuration.js';
import { OtpSendError, type OtpSendRequest, type OtpSender } from './otp-sender.interface.js';

const TERMII_BASE_URL = 'https://api.ng.termii.com';
const SEND_TIMEOUT_MS = 10_000;

/**
 * SMS delivery via Termii's generic send API. The generated code is embedded
 * in the message text. Fails closed: network errors and non-2xx responses
 * become `OtpSendError` (never swallowed).
 */
@Injectable()
export class TermiiOtpSender implements OtpSender {
  private readonly apiKey: string;
  private readonly senderId: string;

  constructor(config: ConfigService<AppConfig, true>) {
    const termii = config.get('termii');
    this.apiKey = termii.apiKey;
    this.senderId = termii.senderId;
  }

  async send(request: OtpSendRequest): Promise<void> {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), SEND_TIMEOUT_MS);
    try {
      const response = await globalThis.fetch(`${TERMII_BASE_URL}/api/v2/sms/send`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          api_key: this.apiKey,
          to: request.target,
          from: this.senderId,
          type: 'plain',
          channel: 'generic',
          sms: `Your Bonde verification code is ${request.code}. It expires in 5 minutes.`,
        }),
        signal: controller.signal,
      });
      if (!response.ok) {
        throw new OtpSendError(`Termii returned HTTP ${response.status}`);
      }
    } catch (error) {
      if (error instanceof OtpSendError) throw error;
      throw new OtpSendError('SMS delivery failed');
    } finally {
      clearTimeout(timer);
    }
  }
}
