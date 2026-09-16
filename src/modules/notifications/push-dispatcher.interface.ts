/** A single FCM push message bound to one device token. */
export interface PushMessage {
  deviceToken: string;
  title: string;
  body: string;
  /** String→string payload carried to the app (route hints, ids, ...). */
  data?: Record<string, string>;
}

/**
 * Outbound push delivery boundary. Implementations are **best-effort**
 * (fail-open): a delivery failure must never fail the request that produced
 * the message — in-app notifications are the source of truth and always
 * record. Mirror the MAIL/OTP sender token pattern: feature code depends on
 * `PUSH_DISPATCHER`, and tests override the token with a capturing stub.
 */
export interface PushDispatcher {
  isEnabled(): boolean;
  send(message: PushMessage): Promise<void>;
}

/** DI token bound to the configured push dispatcher (default Firebase/FCM). */
export const PUSH_DISPATCHER = Symbol('PUSH_DISPATCHER');

/**
 * No-op dispatcher — bound when FCM is not configured (dev-local, unit tests,
 * or a deployment that deliberately skips push). Keeps feature code and its
 * in-app notification writes working with zero delivery side effects.
 */
export class NoopPushDispatcher implements PushDispatcher {
  isEnabled(): boolean {
    return false;
  }

  async send(): Promise<void> {
    /* intentionally a no-op */
  }
}
