import { Injectable } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import type { AppConfig } from '../../config/configuration.js';
import { MailSendError, type MailMessage, type MailSender } from './mail.types.js';

const RESEND_BASE_URL = 'https://api.resend.com';
const SEND_TIMEOUT_MS = 10_000;

/**
 * Transactional email delivery via Resend. Fails closed: network errors and
 * non-2xx responses become `MailSendError`. Feature code should inject the
 * `MAIL_SENDER` token — tests override it to capture messages and to keep
 * real email out of the test environment.
 */
@Injectable()
export class MailService implements MailSender {
  private readonly apiKey: string;
  private readonly fromEmail: string;

  constructor(config: ConfigService<AppConfig, true>) {
    const resend = config.get('resend');
    this.apiKey = resend.apiKey;
    this.fromEmail = resend.fromEmail;
  }

  async send(message: MailMessage): Promise<void> {
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
          to: [message.to],
          subject: message.subject,
          html: message.html,
        }),
        signal: controller.signal,
      });
      if (!response.ok) {
        throw new MailSendError(`Resend returned HTTP ${response.status}`);
      }
    } catch (error) {
      if (error instanceof MailSendError) throw error;
      throw new MailSendError('Email delivery failed');
    } finally {
      clearTimeout(timer);
    }
  }
}
