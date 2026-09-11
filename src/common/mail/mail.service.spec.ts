import { beforeEach, describe, expect, it, vi } from 'vitest';
import { ConfigService } from '@nestjs/config';
import type { AppConfig } from '../../config/configuration.js';
import { MailService } from './mail.service.js';
import { MailSendError } from './mail.types.js';
import { logoDataUri } from './templates/assets/logo.js';

const RESEND_URL = 'https://api.resend.com/emails';

function makeService(nodeEnv = 'production', logoUrl?: string) {
  const config = {
    get: vi.fn((key: keyof AppConfig) => {
      if (key === 'resend')
        return { apiKey: 're_secret', fromEmail: 'Bonde <noreply@bonde.app>', logoUrl };
      if (key === 'nodeEnv') return nodeEnv;
      return undefined;
    }),
  } as unknown as ConfigService<AppConfig, true>;
  const service = new MailService(config);
  return { service, config };
}

describe('MailService', () => {
  beforeEach(() => {
    vi.unstubAllGlobals();
  });

  it('sends the message through the Resend API', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async (url: RequestInfo | URL, init: RequestInit) => {
        expect(String(url)).toBe(RESEND_URL);
        const headers = (init?.headers ?? {}) as Record<string, string>;
        expect(headers['Authorization']).toBe('Bearer re_secret');
        const body = JSON.parse(String(init?.body));
        expect(body).toMatchObject({
          from: 'Bonde <noreply@bonde.app>',
          to: ['amina@bonde.app'],
          subject: 'Hello',
          html: '<p>hi</p>',
        });
        return new Response(null, { status: 200 });
      }),
    );
    const { service } = makeService();

    await expect(
      service.send({ to: 'amina@bonde.app', subject: 'Hello', html: '<p>hi</p>' }),
    ).resolves.toBeUndefined();
  });

  it('fails closed on a non-2xx response', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => new Response('nope', { status: 429 })),
    );
    const { service } = makeService();

    await expect(
      service.send({ to: 'a@bonde.app', subject: 's', html: 'h' }),
    ).rejects.toBeInstanceOf(MailSendError);
  });

  it('surfaces the Resend status + body in the error (production)', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => new Response('{"message":"The domain is not verified"}', { status: 403 })),
    );
    const { service } = makeService();

    await expect(
      service.send({ to: 'a@bonde.app', subject: 's', html: 'h' }),
    ).rejects.toMatchObject({
      name: 'MailSendError',
      message: expect.stringContaining('Resend returned HTTP 403'),
    });
  });

  it('fails closed on a network error', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => {
        throw new TypeError('fetch failed');
      }),
    );
    const { service } = makeService();

    await expect(service.send({ to: 'a@bonde.app', subject: 's', html: 'h' })).rejects.toThrowError(
      MailSendError,
    );
  });

  it('logs the message and succeeds instead of failing in development', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => new Response('{"message":"unverified domain"}', { status: 403 })),
    );
    const { service } = makeService('development');

    await expect(
      service.send({ to: 'amina@bonde.app', subject: 'Your Bonde code', html: '<p>1234</p>' }),
    ).resolves.toBeUndefined();
  });

  it('logs a network failure and succeeds instead of failing in development', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => {
        throw new TypeError('getaddrinfo ENOTFOUND api.resend.com');
      }),
    );
    const { service } = makeService('development');

    await expect(
      service.send({ to: 'amina@bonde.app', subject: 'Your Bonde code', html: '<p>5678</p>' }),
    ).resolves.toBeUndefined();
  });

  it('aborts the request after the send timeout', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async (_url: RequestInfo | URL, init: RequestInit) => {
        expect(init?.signal).toBeInstanceOf(AbortSignal);
        return new Response(null, { status: 200 });
      }),
    );
    const { service } = makeService();
    await service.send({ to: 'a@bonde.app', subject: 's', html: 'h' });
  });

  it('swaps the data-URI logo for the hosted URL when MAIL_LOGO_URL is set', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async (_url: RequestInfo | URL, init: RequestInit) => {
        const body = JSON.parse(String(init?.body));
        expect(body.html).toContain('src="https://x.supabase.co/logo/logo.png"');
        expect(body.html).not.toContain('data:image/png;base64,');
        return new Response(null, { status: 200 });
      }),
    );
    const { service } = makeService('production', 'https://x.supabase.co/logo/logo.png');

    await service.send({
      to: 'a@bonde.app',
      subject: 's',
      html: `<img src="${logoDataUri}" alt="Bonde" />`,
    });
  });

  it('keeps the data-URI logo when no hosted URL is configured', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async (_url: RequestInfo | URL, init: RequestInit) => {
        const body = JSON.parse(String(init?.body));
        expect(body.html).toContain(`src="${logoDataUri}"`);
        return new Response(null, { status: 200 });
      }),
    );
    const { service } = makeService();

    await service.send({
      to: 'a@bonde.app',
      subject: 's',
      html: `<img src="${logoDataUri}" alt="Bonde" />`,
    });
  });
});
