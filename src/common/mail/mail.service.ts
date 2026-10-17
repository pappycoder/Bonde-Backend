import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import type { AppConfig } from '../../config/configuration.js';
import { mailAssets } from './templates/assets/index.js';
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
 * Delivery failures are reported in every environment; logging a message never
 * counts as delivery and credential bodies must not be written to logs.
 */
@Injectable()
export class MailService implements MailSender {
  private readonly apiKey: string;
  private readonly fromEmail: string;
  private readonly logoUrl?: string;
  private readonly assetBaseUrl?: string;
  private readonly logger = new Logger('MailService');

  constructor(config: ConfigService<AppConfig, true>) {
    const resend = config.get('resend');
    this.apiKey = resend.apiKey;
    this.fromEmail = resend.fromEmail;
    this.logoUrl = resend.logoUrl;
    this.assetBaseUrl = resend.assetBaseUrl;
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
          html: this.resolveAssets(message.html),
        }),
        signal: controller.signal,
      });
      if (!response.ok) {
        throw new MailSendError(await this.responseDetail(response));
      }
    } catch (error) {
      const failure =
        error instanceof MailSendError
          ? error
          : new MailSendError(
              `Email delivery failed: ${error instanceof Error ? error.message : String(error)}`,
            );
      this.logger.error(failure.message);
      throw failure;
    } finally {
      clearTimeout(timer);
    }
  }

  /**
   * Swap the embedded data URIs for hosted URLs.
   *
   * Gmail and Outlook both strip `data:` images, so production needs a public
   * host. Two levels of configuration:
   *
   * - `MAIL_ASSET_BASE_URL` rewrites *every* asset by its registry `file`, which
   *   is what you want — one folder on a CDN holding logo.png plus the social
   *   marks.
   * - `MAIL_LOGO_URL` rewrites only the logo, and is kept for backwards
   *   compatibility with existing deployments.
   *
   * With neither set the data URIs ship as-is, which still renders correctly in
   * Apple Mail and most webmail clients.
   */
  private resolveAssets(html: string): string {
    let output = html;

    for (const asset of Object.values(mailAssets)) {
      if (this.assetBaseUrl) {
        const base = this.assetBaseUrl.replace(/\/+$/, '');
        output = output.split(asset.dataUri).join(`${base}/${asset.file}`);
      } else if (asset === mailAssets.logo && this.logoUrl) {
        output = output.split(asset.dataUri).join(this.logoUrl);
      }
    }

    return output;
  }

  private async responseDetail(response: Response): Promise<string> {
    const text = (await response.text()).trim();
    const snippet = text ? text.slice(0, RESEND_ERROR_SNIPPET) : '';
    return snippet
      ? `Resend returned HTTP ${response.status}: ${snippet}`
      : `Resend returned HTTP ${response.status}`;
  }
}
