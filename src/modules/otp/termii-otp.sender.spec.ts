import { ConfigService } from '@nestjs/config';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { AppConfig } from '../../config/configuration.js';
import { OtpSendError, type OtpSendRequest } from './otp-sender.interface.js';
import { TermiiOtpSender, toTermiiE164 } from './termii-otp.sender.js';

const TERMII_URL = 'https://api.ng.termii.com/api/v2/sms/send';
const CODE = '4815';

function makeConfig(): ConfigService<AppConfig, true> {
  return {
    get: vi.fn(() => ({ apiKey: 'termii-key', senderId: 'Bonde' })),
  } as unknown as ConfigService<AppConfig, true>;
}

function responseLike(status: number, body: unknown): Response {
  return {
    ok: status >= 200 && status < 300,
    status,
    text: async () => JSON.stringify(body),
  } as unknown as Response;
}

describe('TermiiOtpSender', () => {
  const fetchMock = vi.fn();
  let sender: TermiiOtpSender;
  let request: OtpSendRequest;

  beforeEach(() => {
    fetchMock.mockReset();
    vi.stubGlobal('fetch', fetchMock);
    sender = new TermiiOtpSender(makeConfig());
    request = { channel: 'PHONE' as never, target: '+2348000000001', code: CODE };
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('accepts a 200 response whose body marks the send as ok', async () => {
    fetchMock.mockResolvedValueOnce(
      responseLike(200, { code: 'ok', message_id: '9154112', message: 'Successfully Sent' }),
    );

    await expect(sender.send(request)).resolves.toBeUndefined();
  });

  it('posts the expected Termii payload with a normalized recipient', async () => {
    fetchMock.mockResolvedValueOnce(responseLike(200, { code: 'ok' }));

    await sender.send(request);

    expect(fetchMock).toHaveBeenCalledOnce();
    const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(url).toBe(TERMII_URL);
    expect(init.method).toBe('POST');
    const body = JSON.parse(init.body as string);
    expect(body).toMatchObject({
      api_key: 'termii-key',
      to: '2348000000001',
      from: 'Bonde',
      type: 'plain',
      channel: 'generic',
    });
    expect(body.sms).toContain(CODE);
  });

  it('normalizes national leading-zero numbers and passes E.164 through', () => {
    expect(toTermiiE164('+2348000000001')).toBe('2348000000001');
    expect(toTermiiE164('08080000002')).toBe('2348080000002');
    expect(toTermiiE164('2348000000001')).toBe('2348000000001');
    expect(toTermiiE164('+1 650 555 0123')).toBe('16505550123');
  });

  it('fails closed on a 2xx body Termii marks as error', async () => {
    fetchMock.mockResolvedValueOnce(
      responseLike(200, { code: 'error', message: 'Invalid Sender Id' }),
    );

    const error = await sender.send(request).catch((e: Error) => e);
    expect(error).toBeInstanceOf(OtpSendError);
    expect(error.message).toContain('Termii returned HTTP 200');
  });

  it('fails closed on a non-2xx response with the server detail', async () => {
    fetchMock.mockResolvedValueOnce(responseLike(500, { code: 'error', message: 'Server Error' }));

    const error = await sender.send(request).catch((e: Error) => e);
    expect(error).toBeInstanceOf(OtpSendError);
    expect(error.message).toContain('Termii returned HTTP 500');
  });

  it('fails closed on an unparseable 2xx body', async () => {
    fetchMock.mockResolvedValueOnce({
      ok: true,
      status: 200,
      text: async () => 'not json',
    } as unknown as Response);

    await expect(sender.send(request)).rejects.toThrow(OtpSendError);
  });

  it('fails closed on a network error', async () => {
    fetchMock.mockRejectedValueOnce(new Error('ECONNRESET'));

    const error = await sender.send(request).catch((e: Error) => e);
    expect(error).toBeInstanceOf(OtpSendError);
  });
});
