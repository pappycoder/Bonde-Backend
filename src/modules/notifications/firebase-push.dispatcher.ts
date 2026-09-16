import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import type { App } from 'firebase-admin/app';
import { cert, getApps, initializeApp } from 'firebase-admin/app';
import { getMessaging } from 'firebase-admin/messaging';
import type { AppConfig } from '../../config/configuration.js';
import type { PushDispatcher, PushMessage } from './push-dispatcher.interface.js';

/**
 * FCM push delivery via the Firebase Admin SDK (HTTP v1).
 *
 * **Best-effort / fail-open**: push is a bonus channel — in-app notifications
 * are the source of truth and are always recorded first. A missing or broken
 * Firebase config (or a per-message FCM error) must never fail the request
 * that produced the message, so `send` logs and swallows. This mirrors the
 * OTP/MAIL best-effort convention. When `FIREBASE_SERVICE_ACCOUNT_PATH` is
 * absent, `isEnabled()` is false and dispatch is a no-op.
 *
 * The Firebase app is initialized **lazily** on first enablement and cached;
 * `initializeApp` is idempotent per name so a global restart never collides.
 *
 * Credentials can be supplied two ways (either enables push):
 *   - `FIREBASE_SERVICE_ACCOUNT_JSON`  — inline service-account JSON. This is
 *     the shape for serverless hosts (Vercel) with no persistent filesystem.
 *   - `FIREBASE_SERVICE_ACCOUNT_PATH`  — filesystem path to the JSON, for
 *     local dev and hosts that mount secrets (K8s volumes, Render disks).
 * When both are absent, `isEnabled()` is false and dispatch is a no-op.
 */
@Injectable()
export class FirebasePushDispatcher implements PushDispatcher {
  private readonly logger = new Logger('PushDispatcher');
  private app?: App;
  private bootAttempted = false;

  constructor(private readonly config: ConfigService<AppConfig, true>) {}

  isEnabled(): boolean {
    const push = this.config.get('push');
    return Boolean(push.fcmServiceAccountJson ?? push.fcmServiceAccountPath);
  }

  async send(message: PushMessage): Promise<void> {
    if (!this.isEnabled()) return;

    const app = this.adminApp();
    if (!app) return;

    try {
      await getMessaging(app).send({
        token: message.deviceToken,
        notification: { title: message.title, body: message.body },
        data: message.data,
      });
      this.logger.debug(`[push] delivered to ${message.deviceToken.slice(0, 10)}…`);
    } catch (error) {
      // Log, never throw — push is best-effort.
      this.logger.warn(
        `[push] delivery failed for ${message.deviceToken.slice(0, 10)}…: ${(error as Error).message}`,
      );
    }
  }

  private adminApp(): App | undefined {
    if (this.bootAttempted) return this.app;
    this.bootAttempted = true;

    const push = this.config.get('push');
    const path = push.fcmServiceAccountPath;
    const json = push.fcmServiceAccountJson;

    // Inline JSON wins on hosts with no persistent filesystem (Vercel
    // serverless); a path fallback covers local dev and mounted-secret prod.
    const credential = json ? cert(JSON.parse(json as string)) : path ? cert(path) : undefined;

    if (!credential) return undefined;

    // Reuse a running Firebase app if something already booted one under the
    // default name (e.g. another module), else initialize (lazy, best-effort).
    const existing = getApps().find((app) => app.name === 'bonde-push');
    if (existing) {
      this.app = existing;
      return this.app;
    }

    try {
      this.app = initializeApp({ credential, projectId: push.fcmProjectId }, 'bonde-push');
      this.logger.log('[push] FCM app initialised');
    } catch (error) {
      this.logger.warn(`[push] FCM init failed: ${(error as Error).message}`);
    }
    return this.app;
  }
}
