import { Injectable, ServiceUnavailableException } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { importPKCS8, SignJWT } from 'jose';
import type { AppConfig } from '../../config/configuration.js';

export class ProviderError extends Error {
  constructor(
    readonly definitive: boolean,
    readonly status: number,
  ) {
    super(definitive ? 'Provider rejected the request' : 'Provider outcome is unknown');
  }
}
export type ProviderObject = Record<string, unknown>;
export function object(value: unknown): ProviderObject {
  if (!value || typeof value !== 'object' || Array.isArray(value))
    throw new ProviderError(false, 502);
  return value as ProviderObject;
}
export function string(value: unknown): string {
  if (typeof value !== 'string' || !value) throw new ProviderError(false, 502);
  return value;
}
async function request(
  base: string,
  path: string,
  headers: Record<string, string>,
  method: string,
  body?: unknown,
): Promise<unknown> {
  let response: Response;
  try {
    response = await fetch(`${base}${path}`, {
      method,
      headers: { 'Content-Type': 'application/json', ...headers },
      body: body === undefined ? undefined : JSON.stringify(body),
      signal: AbortSignal.timeout(8000),
      redirect: 'error',
    });
  } catch {
    throw new ProviderError(false, 0);
  }
  if (!response.ok)
    throw new ProviderError(
      [400, 401, 402, 403, 404, 422].includes(response.status),
      response.status,
    );
  let json: ProviderObject;
  try {
    json = object(await response.json());
  } catch {
    throw new ProviderError(false, 502);
  }
  if (typeof json.statusCode === 'number' && json.statusCode >= 400)
    throw new ProviderError(json.statusCode < 500, json.statusCode);
  return json.data ?? json;
}
@Injectable()
export class SudoClient {
  constructor(private readonly config: ConfigService<AppConfig, true>) {}
  async call(path: string, method = 'GET', body?: unknown): Promise<unknown> {
    const c = this.config.get('finance');
    if (!c.sudoKey) throw new ServiceUnavailableException('Sudo is not configured');
    return request(c.sudoBaseUrl, path, { Authorization: `Bearer ${c.sudoKey}` }, method, body);
  }
}
@Injectable()
export class SafeHavenClient {
  private token?: { access: string; client: string; expires: number };
  private pending?: Promise<{ access: string; client: string; expires: number }>;
  constructor(private readonly config: ConfigService<AppConfig, true>) {}
  private async credentials() {
    if (this.token && this.token.expires > Date.now() + 60000) return this.token;
    if (this.pending) return this.pending;
    this.pending = this.exchange();
    try {
      this.token = await this.pending;
      return this.token;
    } finally {
      this.pending = undefined;
    }
  }
  private async exchange() {
    const c = this.config.get('finance');
    if (!c.safeHavenClientId || !c.safeHavenPrivateKey)
      throw new ServiceUnavailableException('Safe Haven is not configured');
    const key = await importPKCS8(c.safeHavenPrivateKey.replace(/\\n/g, '\n'), 'RS256');
    const assertion = await new SignJWT({})
      .setProtectedHeader({ alg: 'RS256', typ: 'JWT' })
      .setIssuer(c.safeHavenIssuer)
      .setSubject(c.safeHavenClientId)
      .setAudience(c.safeHavenBaseUrl)
      .setIssuedAt()
      .setExpirationTime('5m')
      .sign(key);
    // OAuth response is not wrapped in data on all Safe Haven environments.
    const data = object(
      await request(c.safeHavenBaseUrl, '/oauth2/token', {}, 'POST', {
        grant_type: 'client_credentials',
        client_id: c.safeHavenClientId,
        client_assertion: assertion,
        client_assertion_type: 'urn:ietf:params:oauth:client-assertion-type:jwt-bearer',
      }),
    );
    return {
      access: string(data.access_token),
      client: string(data.ibs_client_id),
      expires: Date.now() + Math.max(0, Number(data.expires_in ?? 300)) * 1000,
    };
  }
  async call(path: string, method = 'GET', body?: unknown): Promise<unknown> {
    const token = await this.credentials();
    return request(
      this.config.get('finance').safeHavenBaseUrl,
      path,
      { Authorization: `Bearer ${token.access}`, ClientID: token.client },
      method,
      body,
    );
  }
  banks() {
    return this.call('/transfers/banks');
  }
  resolve(bankCode: string, accountNumber: string) {
    return this.call('/transfers/name-enquiry', 'POST', { bankCode, accountNumber });
  }
}
