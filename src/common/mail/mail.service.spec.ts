import { beforeEach, describe, expect, it, vi } from 'vitest';
import { ConfigService } from '@nestjs/config';
import type { AppConfig } from '../../config/configuration.js';
import { MailService } from './mail.service.js';
import { MailSendError } from './mail.types.js';
import { mailAssets } from './templates/assets/index.js';

const RESEND_URL = 'https://api.resend.com/emails';

function makeService(nodeEnv = 'production', logoUrl?: string, assetBaseUrl?: string) {
  const config = {
    get: vi.fn((key: keyof AppConfig) => {
      if (key === 'resend')
        return {
          apiKey: 're_secret',
          fromEmail: 'Bonde <noreply@bonde.app>',
          logoUrl,
          assetBaseUrl,
        };
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

  it('fails closed instead of pretending delivery succeeded in development', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => new Response('{"message":"unverified domain"}', { status: 403 })),
    );
    const { service } = makeService('development');

    await expect(
      service.send({ to: 'amina@bonde.app', subject: 'Your Bonde code', html: '<p>1234</p>' }),
    ).rejects.toBeInstanceOf(MailSendError);
  });

  it('reports network failures in development', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => {
        throw new TypeError('getaddrinfo ENOTFOUND api.resend.com');
      }),
    );
    const { service } = makeService('development');

    await expect(
      service.send({ to: 'amina@bonde.app', subject: 'Your Bonde code', html: '<p>5678</p>' }),
    ).rejects.toBeInstanceOf(MailSendError);
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
      html: `<img src="${mailAssets.logo.dataUri}" alt="Bonde" />`,
    });
  });

  it('uses the existing public PNG host when no override is configured', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async (_url: RequestInfo | URL, init: RequestInit) => {
        const body = JSON.parse(String(init?.body));
        expect(body.html).toContain(`src="${mailAssets.logo.src}"`);
        expect(body.html).not.toContain('data:image');
        return new Response(null, { status: 200 });
      }),
    );
    const { service } = makeService();

    await service.send({
      to: 'a@bonde.app',
      subject: 's',
      html: `<img src="${mailAssets.logo.dataUri}" alt="Bonde" />`,
    });
  });

  it('rewrites every asset when MAIL_ASSET_BASE_URL is set, overriding MAIL_LOGO_URL', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async (_url: RequestInfo | URL, init: RequestInit) => {
        const body = JSON.parse(String(init?.body));
        for (const asset of Object.values(mailAssets)) {
          expect(body.html).toContain(`src="https://cdn.bonde.app/mail/${asset.file}"`);
        }
        expect(body.html).not.toContain('data:image/png;base64,');
        // The per-asset logo override must not win over the base URL.
        expect(body.html).not.toContain('https://x.supabase.co/logo/logo.png');
        return new Response(null, { status: 200 });
      }),
    );
    const { service } = makeService(
      'production',
      'https://x.supabase.co/logo/logo.png',
      'https://cdn.bonde.app/mail',
    );

    await service.send({
      to: 'a@bonde.app',
      subject: 's',
      html: Object.values(mailAssets)
        .map((asset) => `<img src="${asset.dataUri}" alt="${asset.alt}" />`)
        .join(''),
    });
  });

  it('tolerates a trailing slash on MAIL_ASSET_BASE_URL', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async (_url: RequestInfo | URL, init: RequestInit) => {
        const body = JSON.parse(String(init?.body));
        expect(body.html).toContain('src="https://cdn.bonde.app/mail/logo.png"');
        expect(body.html).not.toContain('mail//logo.png');
        return new Response(null, { status: 200 });
      }),
    );
    const { service } = makeService('production', undefined, 'https://cdn.bonde.app/mail/');

    await service.send({
      to: 'a@bonde.app',
      subject: 's',
      html: `<img src="${mailAssets.logo.dataUri}" alt="Bonde" />`,
    });
  });
  it.each([
    'http://cdn.example.com/mail',
    'https://localhost/mail',
    'https://127.0.0.1/mail',
    'https://user:password@cdn.example.com/mail',
    'https://cdn.example.com/mail?token=expires',
  ])('rejects unsafe image hosting before delivery: %s', async (base) => {
    const fetch = vi.fn();
    vi.stubGlobal('fetch', fetch);
    const { service } = makeService('production', undefined, base);
    await expect(service.send({ to: 'a@example.com', subject: 's', html: 'h' })).rejects.toThrow(
      MailSendError,
    );
    expect(fetch).not.toHaveBeenCalled();
  });

  it('resolves HTTPS template sources for every icon', async () => {
    const fetch = vi.fn(
      async (_url: RequestInfo | URL, _init: RequestInit) => new Response(null, { status: 200 }),
    );
    vi.stubGlobal('fetch', fetch);
    const { service } = makeService('production', undefined, 'https://cdn.example.com/mail');
    await service.send({
      to: 'a@example.com',
      subject: 's',
      html: Object.values(mailAssets)
        .map((asset) => `<img src="${asset.src}" />`)
        .join(''),
    });
    const body = JSON.parse(String(fetch.mock.calls[0]?.[1]?.body));
    for (const asset of Object.values(mailAssets)) {
      expect(body.html).toContain(`src="https://cdn.example.com/mail/${asset.file}"`);
    }
    expect(body.html).not.toContain('data:');
  });
});
