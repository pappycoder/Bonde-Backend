import { beforeEach, describe, expect, it, vi } from 'vitest';
import { ConfigService } from '@nestjs/config';
import type { AppConfig } from '../../../config/configuration.js';
import { SupabaseAuthClient } from './supabase-auth.client.js';

function makeClient() {
  const config = {
    get: vi.fn((key: keyof AppConfig) => {
      if (key === 'supabase')
        return {
          url: 'https://sb.supabase.co',
          anonKey: 'anon-key',
          serviceRoleKey: 'service-role-key',
        };
      return undefined;
    }),
  } as unknown as ConfigService<AppConfig, true>;
  return new SupabaseAuthClient(config);
}

describe('SupabaseAuthClient', () => {
  beforeEach(() => vi.unstubAllGlobals());

  it('maps a GoTrue payload error to the named code', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async (_url: string | URL, init: RequestInit) => {
        const headers = (init?.headers ?? {}) as Record<string, string>;
        expect(headers['authorization']).toBe('Bearer service-role-key');
        return new Response(
          JSON.stringify({ code: 'users_email_address_already_exist', msg: 'dup' }),
          { status: 409 },
        );
      }),
    );
    const client = makeClient();

    await expect(
      client.signUp({ email: 'a@b.com', password: 'long.enough.1', fullName: 'A' }),
    ).rejects.toMatchObject({ code: 'USER_EXISTS' });
  });

  it('maps a 401 on an admin request to CONFIG (service role misconfiguration)', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => new Response(JSON.stringify({ msg: 'Invalid JWT' }), { status: 401 })),
    );
    const client = makeClient();

    await expect(
      client.signUp({ email: 'a@b.com', password: 'long.enough.1', fullName: 'A' }),
    ).rejects.toMatchObject({ code: 'CONFIG' });
  });

  it('maps a 400 admin validation error to VALIDATION', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(
        async () =>
          new Response(
            JSON.stringify({ code: 'email_address_invalid', msg: 'Invalid email address.' }),
            { status: 400 },
          ),
      ),
    );
    const client = makeClient();

    await expect(
      client.signUp({ email: 'bad', password: 'long.enough.1', fullName: 'A' }),
    ).rejects.toMatchObject({ code: 'VALIDATION' });
  });

  it('maps a 401 invalid_grant on the token route to INVALID_CREDENTIALS', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(
        async () =>
          new Response(
            JSON.stringify({ error: 'invalid_grant', error_description: 'bad password' }),
            { status: 401 },
          ),
      ),
    );
    const client = makeClient();

    await expect(client.signInWithPassword('a@b.com', 'wrong')).rejects.toMatchObject({
      code: 'INVALID_CREDENTIALS',
    });
  });

  it('maps a 400 email_not_confirmed on the token route to EMAIL_NOT_CONFIRMED', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(
        async () =>
          new Response(
            JSON.stringify({ error: 'email_not_confirmed', error_description: 'not confirmed' }),
            { status: 400 },
          ),
      ),
    );
    const client = makeClient();

    await expect(client.signInWithPassword('a@b.com', 'good')).rejects.toMatchObject({
      code: 'EMAIL_NOT_CONFIRMED',
    });
  });

  it('wraps network failures as PROVIDER with underlying detail', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => {
        throw new TypeError('fetch failed');
      }),
    );
    const client = makeClient();

    await expect(
      client.signUp({ email: 'a@b.com', password: 'long.enough.1', fullName: 'A' }),
    ).rejects.toMatchObject({ code: 'PROVIDER', message: expect.stringContaining('fetch failed') });
  });

  it('includes the status in the message when GoTrue returns a non-JSON error', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => new Response('oops', { status: 500 })),
    );
    const client = makeClient();

    await expect(
      client.signUp({ email: 'a@b.com', password: 'long.enough.1', fullName: 'A' }),
    ).rejects.toMatchObject({
      code: 'PROVIDER',
      message: expect.stringContaining('500'),
    });
  });
});
