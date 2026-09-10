import { beforeEach, describe, expect, it, vi } from 'vitest';
import { ConfigService } from '@nestjs/config';
import type { AppConfig } from '../../config/configuration.js';
import { MailService } from './mail.service.js';
import { MailSendError } from './mail.types.js';

const RESEND_URL = 'https://api.resend.com/emails';

function makeService() {
  const config = {
    get: vi.fn((key: keyof AppConfig) => {
      if (key === 'resend') return { apiKey: 're_secret', fromEmail: 'Bonde <noreply@bonde.app>' };
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

  it('fails closed on a network error', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => {
        throw new TypeError('ECONNREFUSED');
      }),
    );
    const { service } = makeService();

    await expect(
      service.send({ to: 'a@bonde.app', subject: 's', html: 'h' }),
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
});
