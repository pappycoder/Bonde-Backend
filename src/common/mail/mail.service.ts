import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import type { AppConfig } from '../../config/configuration.js';
import { logoDataUri } from './templates/assets/logo.js';
import { MailSendError, type MailMessage, type MailSender } from './mail.types.js';

const RESEND_BASE_URL = 'https://api.resend.com';
const SEND_TIMEOUT_MS = 10_000;
const RESEND_ERROR_SNIPPET = 160;

/**
 * Transactional email delivery via Resend. Fails closed: network errors and
 * non-2xx responses become `MailSendError` with the server-side detail
 * (status + response snippet) so a 503 in the logs says *why*. Feature code
 * should inject the `MAIL_SENDER` token — tests override it to capture
 * messages and to keep real email out of the test environment.
 *
 * In `development` only, a failed delivery is logged (recipient, subject, and
 * full body — where an OTP code is visible) and treated as sent, so local
 * testing never blocks on Resend. `test` and `production` stay fail-closed.
 */
@Injectable()
export class MailService implements MailSender {
  private readonly apiKey: string;
  private readonly fromEmail: string;
  private readonly logoUrl?: string;
  private readonly devFallback: boolean;
  private readonly logger = new Logger('MailService');

  constructor(config: ConfigService<AppConfig, true>) {
    const resend = config.get('resend');
    this.apiKey = resend.apiKey;
    this.fromEmail = resend.fromEmail;
    this.logoUrl = resend.logoUrl;
    this.devFallback = config.get('nodeEnv') === 'development';
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
          html: this.resolveLogo(message.html),
        }),
        signal: controller.signal,
      });
      const detail = await this.responseDetail(response);
      if (!response.ok) {
        this.handleFailure(detail, message);
        return;
      }
    } catch (error) {
      if (error instanceof MailSendError) {
        this.handleFailure(error.message, message);
        return;
      }
      const detail = `Email delivery failed: ${error instanceof Error ? error.message : String(error)}`;
      this.handleFailure(detail, message);
    } finally {
      clearTimeout(timer);
    }
  }

  private handleFailure(detail: string, message: MailMessage): never | void {
    if (this.devFallback) {
      this.logger.warn(
        `[dev-fallback] Resend unreachable (${detail}); logged instead of sent. ` +
          `To: ${message.to} — ${message.subject}`,
      );
      this.logger.warn(message.html);
      return;
    }
    throw new MailSendError(detail);
  }

  /**
   * Email clients block data-URI images (Gmail, Outlook), so when a hosted
   * `MAIL_LOGO_URL` is configured the inline data URI is swapped for it. Falls
   * back to the embedded image when the env is unset.
   */
  private resolveLogo(html: string): string {
    if (!this.logoUrl || !html.includes(logoDataUri)) return html;
    return html.split(logoDataUri).join(this.logoUrl);
  }

  private async responseDetail(response: Response): Promise<string> {
    const text = (await response.text()).trim();
    const snippet = text ? text.slice(0, RESEND_ERROR_SNIPPET) : '';
    return snippet
      ? `Resend returned HTTP ${response.status}: ${snippet}`
      : `Resend returned HTTP ${response.status}`;
  }
}
