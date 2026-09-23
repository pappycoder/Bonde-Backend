import { Injectable } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import type { AppConfig } from '../../config/configuration.js';
import { OtpSendError, type OtpSendRequest, type OtpSender } from './otp-sender.interface.js';

const TERMII_BASE_URL = 'https://api.ng.termii.com';
const SEND_TIMEOUT_MS = 10_000;
const TERMII_ERROR_SNIPPET = 160;

/**
 * SMS delivery via Termii's generic send API. The generated code is embedded
 * in the message text and the recipient is normalized to the numeric E.164
 * form Termii expects. Fails closed: network errors, non-2xx responses, and
 * 2xx bodies Termii marks with `code !== 'ok'` (e.g. insufficient balance,
 * unregistered sender ID) all become `OtpSendError` (never swallowed).
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
          to: toTermiiE164(request.target),
          from: this.senderId,
          type: 'plain',
          channel: 'generic',
          sms: `Your Bonde verification code is ${request.code}. It expires in 5 minutes.`,
        }),
        signal: controller.signal,
      });
      const text = (await response.text()).trim();
      if (!response.ok || !isTermiiAccepted(text)) {
        throw new OtpSendError(termiiDetail(response.status, text));
      }
    } catch (error) {
      if (error instanceof OtpSendError) throw error;
      throw new OtpSendError('SMS delivery failed');
    } finally {
      clearTimeout(timer);
    }
  }
}

/**
 * Termii wants a bare numeric E.164 (`2348012345678`, no leading `+`). Strip
 * whitespace/`+` and expand a national leading `0` to the Nigerian `234`
 * country code; anything already international passes through untouched.
 */
export function toTermiiE164(phone: string): string {
  const compact = phone.replace(/\s+/g, '');
  const stripped = compact.startsWith('+') ? compact.slice(1) : compact;
  return stripped.startsWith('0') ? `234${stripped.slice(1)}` : stripped;
}

/**
 * Termii reports accepted sends as HTTP 200 with `code: "ok"` in the body;
 * soft failures (invalid/unregistered sender ID, insufficient balance) also
 * come back on 2xx with `code: "error"`. Only the body is authoritative, so
 * anything unparseable or not `ok` counts as a failed delivery.
 */
function isTermiiAccepted(text: string): boolean {
  try {
    const body = JSON.parse(text) as { code?: string };
    return body.code === 'ok';
  } catch {
    return false;
  }
}

/** Server-side-only failure detail: HTTP status + a snippet of the body. */
function termiiDetail(status: number, text: string): string {
  const snippet = text ? text.slice(0, TERMII_ERROR_SNIPPET) : '';
  return snippet ? `Termii returned HTTP ${status}: ${snippet}` : `Termii returned HTTP ${status}`;
}
