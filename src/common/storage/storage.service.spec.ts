import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import {
  BadRequestException,
  ConflictException,
  ForbiddenException,
  NotFoundException,
  ServiceUnavailableException,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import type { AppConfig } from '../../config/configuration.js';
import { StorageService } from './storage.service.js';

const SUPABASE_URL = 'https://example.supabase.co';
const SERVICE_ROLE_KEY = 'svc-role-secret';

function makeService(): { service: StorageService; fetch: ReturnType<typeof vi.fn> } {
  const fetch = vi.fn();
  vi.stubGlobal('fetch', fetch);
  const config = { get: () => ({ url: SUPABASE_URL, serviceRoleKey: SERVICE_ROLE_KEY }) };
  const service = new StorageService(config as unknown as ConfigService<AppConfig, true>);
  return { service, fetch };
}

function stubResponse(fetch: ReturnType<typeof vi.fn>, body: unknown, status = 200): void {
  fetch.mockResolvedValue({
    ok: status >= 200 && status < 300,
    status,
    async json() {
      return body;
    },
  } as Response);
}

describe('StorageService guardrails', () => {
  let service: StorageService;
  let fetch: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    ({ service, fetch } = makeService());
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('rejects unknown buckets', async () => {
    await expect(
      service.signUploadUrl('bonde-nope' as never, 'a/b.jpg', { contentType: 'image/jpeg' }),
    ).rejects.toThrow(BadRequestException);
    expect(fetch).not.toHaveBeenCalled();
  });

  it.each(['', '/etc/passwd', 'a/../b', 'a//b', 'has space/x', 'a\\b', '.hidden/file'])(
    'rejects unsafe path %j',
    async (path) => {
      await expect(
        service.signUploadUrl('bonde-avatars', path, { contentType: 'image/jpeg' }),
      ).rejects.toThrow(BadRequestException);
      expect(fetch).not.toHaveBeenCalled();
    },
  );

  it('rejects content types not allowed for the bucket', async () => {
    await expect(
      service.signUploadUrl('bonde-avatars', 'u-1/a.pdf', { contentType: 'application/pdf' }),
    ).rejects.toThrow(BadRequestException);
    expect(fetch).not.toHaveBeenCalled();
  });

  it('rejects declared sizes above the bucket cap', async () => {
    await expect(
      service.signUploadUrl('bonde-avatars', 'u-1/a.jpg', {
        contentType: 'image/jpeg',
        size: 6 * 1024 * 1024,
      }),
    ).rejects.toThrow(BadRequestException);
    expect(fetch).not.toHaveBeenCalled();
  });

  it('clamps expiresIn to the bucket bounds and defaults otherwise', async () => {
    stubResponse(fetch, { signedUrl: '/signed/upload?token=t' });

    const low = await service.signUploadUrl('bonde-avatars', 'u-1/a.jpg', {
      contentType: 'image/jpeg',
      expiresIn: 1,
    });
    expect(low.expiresIn).toBe(60);

    const high = await service.signUploadUrl('bonde-avatars', 'u-1/a.jpg', {
      contentType: 'image/jpeg',
      expiresIn: 999_999,
    });
    expect(high.expiresIn).toBe(3600);

    const defaulted = await service.signDownloadUrl('bonde-avatars', 'u-1/a.jpg');
    expect(defaulted.expiresIn).toBe(900);
  });

  it('rejects public-url requests for private buckets', () => {
    expect(() => service.getPublicUrl('bonde-kyc-docs', 'u-1/doc.pdf')).toThrow(
      BadRequestException,
    );
  });
});

describe('StorageService signed URLs', () => {
  let service: StorageService;
  let fetch: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    ({ service, fetch } = makeService());
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('builds an absolute upload URL using the service-role auth and PUT', async () => {
    stubResponse(fetch, { signedUrl: '/object/upload/sign/bonde-avatars/u-1%2Fa.jpg?token=t' });

    const result = await service.signUploadUrl('bonde-avatars', 'u-1/a.jpg', {
      contentType: 'image/jpeg',
      expiresIn: 300,
    });

    expect(result).toMatchObject({
      bucket: 'bonde-avatars',
      path: 'u-1/a.jpg',
      method: 'PUT',
      expiresIn: 300,
      headers: { 'content-type': 'image/jpeg' },
    });
    expect(result.uploadUrl).toBe(
      `${SUPABASE_URL}/storage/v1/object/upload/sign/bonde-avatars/u-1%2Fa.jpg?token=t`,
    );

    const [url, init] = fetch.mock.calls[0] as [string, RequestInit];
    expect(url).toBe(`${SUPABASE_URL}/storage/v1/object/upload/sign/bonde-avatars/u-1/a.jpg`);
    expect(init.method).toBe('POST');
    expect(init.body).toBe(JSON.stringify({ expiresIn: 300 }));
    const headers = init.headers as Record<string, string>;
    expect(headers.Authorization).toBe(`Bearer ${SERVICE_ROLE_KEY}`);
    expect(headers.apikey).toBe(SERVICE_ROLE_KEY);
  });

  it('tolerates the alternative signedURL response shape', async () => {
    stubResponse(fetch, { signedURL: '/object/sign/bonde-avatars/u-1/a.jpg?token=t' });

    const result = await service.signDownloadUrl('bonde-avatars', 'u-1/a.jpg', {
      expiresIn: 600,
    });

    expect(result.signedUrl).toBe(
      `${SUPABASE_URL}/storage/v1/object/sign/bonde-avatars/u-1/a.jpg?token=t`,
    );
  });

  it('returns the absolute path when Supabase already returns a full URL', async () => {
    stubResponse(fetch, { signedUrl: 'https://cdn.supabase.co/object/sign/b/a?token=t' });

    const result = await service.signDownloadUrl('bonde-avatars', 'u-1/a.jpg');

    expect(result.signedUrl).toBe('https://cdn.supabase.co/object/sign/b/a?token=t');
  });

  it('surfaces a missing signed URL as an outage', async () => {
    stubResponse(fetch, {});

    await expect(service.signDownloadUrl('bonde-avatars', 'u-1/a.jpg')).rejects.toThrow(
      ServiceUnavailableException,
    );
  });

  it('throws a typed error for malformed Supabase responses', async () => {
    stubResponse(fetch, null);

    await expect(
      service.signUploadUrl('bonde-avatars', 'u-1/a.jpg', { contentType: 'image/jpeg' }),
    ).rejects.toThrow(ServiceUnavailableException);
  });
});

describe('StorageService objects', () => {
  let service: StorageService;
  let fetch: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    ({ service, fetch } = makeService());
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('builds the public URL for public buckets', () => {
    const result = service.getPublicUrl('bonde-avatars', 'u-1/avatar.jpeg');
    expect(result.publicUrl).toBe(
      `${SUPABASE_URL}/storage/v1/object/public/bonde-avatars/u-1/avatar.jpeg`,
    );
  });

  it('uploads bytes server-side with auth and content headers', async () => {
    stubResponse(fetch, {});

    await service.upload('bonde-avatars', 'u-1/avatar.jpeg', Buffer.from('bytes'), 'image/jpeg');

    const [url, init] = fetch.mock.calls[0] as [string, RequestInit];
    expect(url).toBe(`${SUPABASE_URL}/storage/v1/object/bonde-avatars/u-1/avatar.jpeg`);
    expect(init.method).toBe('POST');
    expect(new TextDecoder().decode(new Uint8Array(init.body as Uint8Array))).toBe('bytes');
    expect((init.headers as Record<string, string>)['Content-Type']).toBe('image/jpeg');
  });

  it('sets x-upsert when requested and rejects disallowed content types', async () => {
    stubResponse(fetch, {});
    await service.upload('bonde-chat-files', 'u-1/m.png', Buffer.from('x'), 'image/png', {
      upsert: true,
    });
    const [, init] = fetch.mock.calls[0] as [string, RequestInit];
    expect((init.headers as Record<string, string>)['x-upsert']).toBe('true');

    await expect(
      service.upload('bonde-chat-files', 'u-1/m.txt', Buffer.from('x'), 'text/plain'),
    ).rejects.toThrow(BadRequestException);
  });

  it('removes an object via the prefixes endpoint', async () => {
    stubResponse(fetch, [{ path: 'u-1/a.jpg' }]);

    await service.remove('bonde-avatars', 'u-1/a.jpg');

    const [url, init] = fetch.mock.calls[0] as [string, RequestInit];
    expect(url).toBe(`${SUPABASE_URL}/storage/v1/object/remove`);
    expect(init.body).toBe(JSON.stringify({ prefixes: ['bonde-avatars/u-1/a.jpg'] }));
  });

  it('lists objects under a prefix', async () => {
    stubResponse(fetch, [
      { name: 'u-1/a.jpg', id: '1' },
      { name: 'u-2/b.jpg', id: '2' },
      { bad: 'entry' },
    ]);

    const entries = await service.list('bonde-avatars', 'u-1');

    expect(entries).toEqual([
      { name: 'u-1/a.jpg', id: '1' },
      { name: 'u-2/b.jpg', id: '2' },
    ]);
    const [, init] = fetch.mock.calls[0] as [string, RequestInit];
    expect(JSON.parse(init.body as string)).toMatchObject({
      prefix: 'u-1',
      sortBy: { column: 'name', order: 'asc' },
    });
  });

  it('creates a bucket idempotently (false when it already exists)', async () => {
    stubResponse(fetch, { name: 'bonde-avatars' });
    const existed = await service.ensureBucket('bonde-avatars');
    expect(existed).toBe(false);
    expect(fetch).toHaveBeenCalledTimes(1);
  });

  it('creates a bucket when it is missing', async () => {
    fetch.mockResolvedValueOnce({
      ok: false,
      status: 404,
      async json() {
        return { message: 'Bucket not found' };
      },
    } as Response);
    stubResponse(fetch, { name: 'bonde-avatars' });

    const created = await service.ensureBucket('bonde-avatars');
    expect(created).toBe(true);

    const [, init] = fetch.mock.calls[1] as [string, RequestInit];
    expect(init.method).toBe('POST');
    expect(JSON.parse(init.body as string)).toMatchObject({
      name: 'bonde-avatars',
      public: true,
      file_size_limit: 5 * 1024 * 1024,
    });
  });
});

describe('StorageService error mapping', () => {
  let service: StorageService;
  let fetch: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    ({ service, fetch } = makeService());
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it.each([
    [400, BadRequestException],
    [404, NotFoundException],
    [409, ConflictException],
  ] as const)('maps HTTP %s to %s', async (status, expected) => {
    stubResponse(fetch, { message: 'nope' }, status);

    await expect(service.signDownloadUrl('bonde-avatars', 'u-1/a.jpg')).rejects.toThrow(expected);
  });

  it('maps 401/403 to ForbiddenException', async () => {
    stubResponse(fetch, { message: 'forbidden' }, 403);

    await expect(service.signDownloadUrl('bonde-avatars', 'u-1/a.jpg')).rejects.toThrow(
      ForbiddenException,
    );
  });

  it('maps 5xx to ServiceUnavailableException', async () => {
    stubResponse(fetch, null, 502);

    await expect(service.signDownloadUrl('bonde-avatars', 'u-1/a.jpg')).rejects.toThrow(
      ServiceUnavailableException,
    );
  });

  it('maps network failures to ServiceUnavailableException', async () => {
    fetch.mockRejectedValue(new TypeError('fetch failed'));

    await expect(service.signDownloadUrl('bonde-avatars', 'u-1/a.jpg')).rejects.toThrow(
      ServiceUnavailableException,
    );
  });
});
