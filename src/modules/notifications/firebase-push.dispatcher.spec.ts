import { beforeEach, describe, expect, it, vi } from 'vitest';
import { ConfigService } from '@nestjs/config';
import type { AppConfig } from '../../config/configuration.js';
import { FirebasePushDispatcher } from './firebase-push.dispatcher.js';
import type { PushMessage } from './push-dispatcher.interface.js';

/**
 * `FirebasePushDispatcher` unit coverage. `firebase-admin` is replaced with
 * in-memory stubs (no credential file, no network, no Vercel, no device) so we
 * can prove the exact FCM wiring that Vercel will exercise in production:
 *
 *   - inline service-account JSON enables push on a serverless host (a path is
 *     **never** required — `FIREBASE_SERVICE_ACCOUNT_PATH` may be empty);
 *   - the credential is injected via `cert()` from either JSON or path;
 *   - the Firebase app is initialised **lazily** under `bonde-push` and reused;
 *   - `send` builds an HTTP v1 `token` payload and is **fail-open** (a failed
 *     delivery logs and must never throw — mirroring OTP/MAIL best-effort);
 *   - with no credential anywhere, `isEnabled()` is false and dispatch is a
 *     no-op.
 */

const messages = vi.hoisted(() => ({
  cert: vi.fn(),
  getApps: vi.fn(),
  initializeApp: vi.fn(),
  getMessaging: vi.fn(),
}));

const adminAppStub = vi.hoisted(() => ({
  name: 'bonde-push',
}));

vi.mock('firebase-admin/app', () => ({
  cert: messages.cert,
  getApps: messages.getApps,
  initializeApp: messages.initializeApp,
}));

vi.mock('firebase-admin/messaging', () => ({
  getMessaging: messages.getMessaging,
}));

const PUSH_MESSAGE: PushMessage = {
  deviceToken: 'device-token-abcdef123456',
  title: 'Funds received',
  body: '₦15,000.00 credited to your wallet',
  data: { route: '/wallet', kind: 'deposit' },
};

const INLINE_JSON = JSON.stringify({
  type: 'service_account',
  project_id: 'bonde-notif',
  private_key_id: '0000000000000000000000000000000000000000',
  private_key: '-----BEGIN PRIVATE KEY-----\nmock\n-----END PRIVATE KEY-----\n',
  client_email: 'firebase-adminsdk@bonde-notif.iam.gserviceaccount.com',
  client_id: '111111111111111111111',
  auth_uri: 'https://accounts.google.com/o/oauth2/auth',
  token_uri: 'https://oauth2.googleapis.com/token',
  auth_provider_x509_cert_url: 'https://www.googleapis.com/oauth2/v1/certs',
  client_x509_cert_url:
    'https://www.googleapis.com/robot/v1/metadata/x509/firebase-adminsdk%40bonde-notif.iam.gserviceaccount.com',
});

const FIREBASE_APP = { name: 'bonde-push' } as never;

function makeConfig(push: Record<string, string | undefined>) {
  const config = {
    get: (key: string) => (key === 'push' ? push : undefined),
  } as unknown as ConfigService<AppConfig, true>;
  return config;
}

function makeDispatcher(push: Record<string, string | undefined>) {
  return new FirebasePushDispatcher(makeConfig(push));
}

const messagingStub = (send: ReturnType<typeof vi.fn>) => ({ send });

beforeEach(() => {
  messages.cert.mockReset();
  messages.getApps.mockReset();
  messages.initializeApp.mockReset();
  messages.getMessaging.mockReset();
});

describe('FirebasePushDispatcher.isEnabled', () => {
  it('is false when neither JSON nor path is configured', () => {
    const dispatcher = makeDispatcher({
      fcmServiceAccountJson: undefined,
      fcmServiceAccountPath: undefined,
    });
    expect(dispatcher.isEnabled()).toBe(false);
  });

  it('is true from the inline JSON alone (empty path is legal)', () => {
    const dispatcher = makeDispatcher({
      fcmServiceAccountJson: INLINE_JSON,
      fcmServiceAccountPath: '',
    });
    expect(dispatcher.isEnabled()).toBe(true);
  });

  it('is true from a path alone', () => {
    const dispatcher = makeDispatcher({
      fcmServiceAccountJson: undefined,
      fcmServiceAccountPath: '/secrets/fcm.json',
    });
    expect(dispatcher.isEnabled()).toBe(true);
  });
});

describe('FirebasePushDispatcher.send', () => {
  it('is a no-op when disabled — the messaging SDK is never touched', async () => {
    const { send } = messagingStub(vi.fn());
    messages.getMessaging.mockReturnValue(send);
    const dispatcher = makeDispatcher({
      fcmServiceAccountJson: undefined,
      fcmServiceAccountPath: undefined,
    });

    await dispatcher.send(PUSH_MESSAGE);

    expect(messages.initializeApp).not.toHaveBeenCalled();
    expect(messages.getMessaging).not.toHaveBeenCalled();
  });

  it('uses the inline JSON credential, initialises lazily under bonde-push, and sends', async () => {
    const send = vi.fn().mockResolvedValue('messages/abc123');
    messages.getApps.mockReturnValue([]);
    messages.cert.mockReturnValue({ type: 'service_account' });
    messages.initializeApp.mockReturnValue(FIREBASE_APP);
    messages.getMessaging.mockReturnValue({ send });

    const dispatcher = makeDispatcher({
      fcmServiceAccountJson: INLINE_JSON,
      fcmServiceAccountPath: '',
      fcmProjectId: 'bonde-notif',
    });

    await dispatcher.send(PUSH_MESSAGE);

    expect(messages.cert).toHaveBeenCalledWith(JSON.parse(INLINE_JSON));
    expect(messages.initializeApp).toHaveBeenCalledWith(
      { credential: { type: 'service_account' }, projectId: 'bonde-notif' },
      'bonde-push',
    );
    expect(messages.getMessaging).toHaveBeenCalledWith(FIREBASE_APP);
    expect(send).toHaveBeenCalledWith(
      expect.objectContaining({
        token: PUSH_MESSAGE.deviceToken,
        notification: { title: PUSH_MESSAGE.title, body: PUSH_MESSAGE.body },
        data: PUSH_MESSAGE.data,
      }),
    );
    expect(send).toHaveBeenCalledOnce();
  });

  it('prefers the inline JSON and initialises only once across sends', async () => {
    const send = vi.fn().mockResolvedValue('messages/abc123');
    messages.getApps.mockReturnValue([]);
    messages.cert.mockReturnValue({ type: 'service_account' });
    messages.initializeApp.mockReturnValue(FIREBASE_APP);
    messages.getMessaging.mockReturnValue({ send });

    const dispatcher = makeDispatcher({
      fcmServiceAccountJson: INLINE_JSON,
      fcmServiceAccountPath: '/secrets/fcm.json', // ignored — JSON wins
      fcmProjectId: 'bonde-notif',
    });

    await dispatcher.send(PUSH_MESSAGE);
    await dispatcher.send(PUSH_MESSAGE);

    expect(messages.cert).toHaveBeenCalledTimes(1);
    expect(messages.cert.mock.calls[0][0]).toEqual(JSON.parse(INLINE_JSON));
    expect(messages.initializeApp).toHaveBeenCalledTimes(1);
    expect(send).toHaveBeenCalledTimes(2);
  });

  it('falls back to the path credential when no inline JSON is set', async () => {
    const send = vi.fn().mockResolvedValue('messages/abc123');
    messages.getApps.mockReturnValue([]);
    messages.cert.mockReturnValue({ type: 'service_account' });
    messages.initializeApp.mockReturnValue(FIREBASE_APP);
    messages.getMessaging.mockReturnValue({ send });

    const dispatcher = makeDispatcher({
      fcmServiceAccountJson: undefined,
      fcmServiceAccountPath: '/secrets/fcm.json',
      fcmProjectId: 'bonde-notif',
    });

    await dispatcher.send(PUSH_MESSAGE);

    expect(messages.cert).toHaveBeenCalledWith('/secrets/fcm.json');
    expect(send).toHaveBeenCalledOnce();
  });

  it('reuses an existing bonde-push app instead of re-initialising', async () => {
    const send = vi.fn().mockResolvedValue('messages/abc123');
    messages.getApps.mockReturnValue([adminAppStub]);
    messages.cert.mockReturnValue({ type: 'service_account' });
    messages.getMessaging.mockReturnValue({ send });

    const dispatcher = makeDispatcher({
      fcmServiceAccountJson: INLINE_JSON,
      fcmServiceAccountPath: '',
      fcmProjectId: 'bonde-notif',
    });

    await dispatcher.send(PUSH_MESSAGE);

    expect(messages.initializeApp).not.toHaveBeenCalled();
    expect(messages.getMessaging).toHaveBeenCalledWith(adminAppStub);
  });

  it('is fail-open — a failed FCM delivery logs and never throws', async () => {
    const send = vi.fn().mockRejectedValue(new Error('invalid registration token'));
    messages.getApps.mockReturnValue([]);
    messages.cert.mockReturnValue({ type: 'service_account' });
    messages.initializeApp.mockReturnValue(FIREBASE_APP);
    messages.getMessaging.mockReturnValue({ send });

    const dispatcher = makeDispatcher({
      fcmServiceAccountJson: INLINE_JSON,
      fcmServiceAccountPath: '',
      fcmProjectId: 'bonde-notif',
    });

    await expect(dispatcher.send(PUSH_MESSAGE)).resolves.toBeUndefined();
  });
});
