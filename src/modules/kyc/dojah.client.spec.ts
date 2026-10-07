import { afterEach, describe, expect, it, vi } from 'vitest';
import { DojahKycClient } from './dojah.client.js';
import { KycProviderError } from './kyc.types.js';

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json' },
  });
}

function makeClient() {
  return new DojahKycClient({
    baseUrl: 'https://api.dojah.io/',
    appId: 'app-id',
    secretKey: 'secret-key',
  });
}

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('DojahKycClient.verifyBvn', () => {
  it('calls the BVN endpoint with only the bvn and both auth headers', async () => {
    const fetchMock = vi.fn(async () =>
      jsonResponse({
        entity: { first_name: 'JOHN', last_name: 'MUSA', date_of_birth: '1997-05-16' },
      }),
    );
    vi.stubGlobal('fetch', fetchMock);

    const result = await makeClient().verifyBvn('22222222222');

    expect(result.verified).toBe(true);
    const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(url).toBe('https://api.dojah.io/api/v1/kyc/bvn?bvn=22222222222');
    expect(init.method).toBe('GET');
    expect(init.headers).toMatchObject({ Authorization: 'secret-key', AppId: 'app-id' });
  });

  it('treats an entity missing core fields as not verified', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => jsonResponse({ entity: { first_name: 'JOHN' } })),
    );
    const result = await makeClient().verifyBvn('22222222222');
    expect(result.verified).toBe(false);
  });

  it('treats no entity as not verified', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => jsonResponse({})),
    );
    const result = await makeClient().verifyBvn('22222222222');
    expect(result.verified).toBe(false);
  });

  it('fails closed as CONFIG when credentials are missing', async () => {
    const fetchMock = vi.fn();
    vi.stubGlobal('fetch', fetchMock);
    const client = new DojahKycClient({
      baseUrl: 'https://api.dojah.io',
      appId: '',
      secretKey: '',
    });

    await expect(client.verifyBvn('22222222222')).rejects.toMatchObject({ code: 'CONFIG' });
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('maps a 5xx to a PROVIDER error', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => jsonResponse({ error: 'boom' }, 500)),
    );
    await expect(makeClient().verifyBvn('22222222222')).rejects.toBeInstanceOf(KycProviderError);
  });
});
