import { BadGatewayException, Injectable, ServiceUnavailableException } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { Prisma } from '@prisma/client';
import type { AppConfig } from '../../config/configuration.js';
import { object, string } from './shopping-values.js';

export const serviceIds = [
  'dstv',
  'gotv',
  'startimes',
  'mtn-data',
  'glo-data',
  'airtel-data',
  'etisalat-data',
] as const;
export const isTv = (id: string) => ['dstv', 'gotv', 'startimes'].includes(id);

/** Provider bodies stay server-side; a timeout or unknown response is never a decline. */
@Injectable()
export class VtpassClient {
  constructor(private readonly config: ConfigService<AppConfig, true>) {}
  get environment() {
    return this.config.get('shopping', { infer: true }).vtpassEnvironment;
  }
  assertEnabled() {
    const c = this.config.get('shopping', { infer: true });
    if (
      !c.vtpassEnabled ||
      !c.vtpassKey ||
      !c.vtpassSecret ||
      !c.vtpassPublic ||
      (c.vtpassEnvironment === 'production' && !c.vtpassLiveApproved)
    )
      throw new ServiceUnavailableException('Service purchases are not available.');
  }
  async call(
    path: string,
    body?: Record<string, unknown>,
    signal?: AbortSignal,
  ): Promise<Record<string, unknown>> {
    this.assertEnabled();
    const c = this.config.get('shopping', { infer: true });
    const base =
      c.vtpassEnvironment === 'production'
        ? 'https://vtpass.com/api'
        : 'https://sandbox.vtpass.com/api';
    const response = await fetch(`${base}${path}`, {
      method: body ? 'POST' : 'GET',
      headers: {
        'api-key': c.vtpassKey,
        ...(body ? { 'secret-key': c.vtpassSecret } : { 'public-key': c.vtpassPublic }),
        'Content-Type': 'application/json',
      },
      ...(body ? { body: JSON.stringify(body) } : {}),
      signal: signal
        ? AbortSignal.any([signal, AbortSignal.timeout(15_000)])
        : AbortSignal.timeout(15_000),
    });
    if (!response.ok)
      throw new BadGatewayException('The service provider is temporarily unavailable.');
    return object(await response.json());
  }
  async balance() {
    const response = await this.call('/balance');
    const raw = object(response.contents).balance;
    if (
      (typeof raw !== 'number' && typeof raw !== 'string') ||
      !Number.isFinite(Number(raw)) ||
      Number(raw) < 0
    )
      throw new BadGatewayException('Could not verify the supplier wallet balance.');
    return new Prisma.Decimal(String(raw)).toDecimalPlaces(6);
  }
  async plans(serviceId: string, signal?: AbortSignal) {
    if (!(serviceIds as readonly string[]).includes(serviceId))
      throw new ServiceUnavailableException('This service is not supported.');
    const result = await this.call(
      `/service-variations?serviceID=${encodeURIComponent(serviceId)}`,
      undefined,
      signal,
    );
    const content = object(result.content);
    if (!Array.isArray(content.variations))
      throw new BadGatewayException('Service plans are unavailable.');
    return content.variations
      .map(object)
      .filter(
        (row) =>
          row.fixedPrice === 'Yes' &&
          /^\d{1,12}(\.\d{1,2})?$/.test(string(row.variation_amount)) &&
          Number(row.variation_amount) > 0,
      )
      .map((row) => ({
        serviceId,
        code: string(row.variation_code),
        name: string(row.name),
        amount: string(row.variation_amount),
        currency: 'NGN',
      }));
  }
  async verify(serviceId: string, beneficiary: string, signal?: AbortSignal) {
    if (!(serviceIds as readonly string[]).includes(serviceId))
      throw new ServiceUnavailableException('This service is not supported.');
    if (!isTv(serviceId)) return { name: null, verified: false, verification: 'PHONE_FORMAT_ONLY' };
    const response = await this.call(
      '/merchant-verify',
      { serviceID: serviceId, billersCode: beneficiary },
      signal,
    );
    const content = object(response.content);
    const name = string(content.Customer_Name || content.customer_name);
    if (content.error || !name)
      throw new BadGatewayException(
        'Could not verify this service account. Check the number and try again.',
      );
    return { name, verified: true, verification: 'PROVIDER' };
  }
}

export function serviceOutcome(
  response: Record<string, unknown>,
): 'SUCCEEDED' | 'FAILED' | 'PENDING' {
  const code = string(response.code);
  const status = string(object(object(response.content).transactions).status).toLowerCase();
  if (['000', '001'].includes(code) && status === 'delivered') return 'SUCCEEDED';
  if (['000', '001'].includes(code) && ['failed', 'reversed'].includes(status)) return 'FAILED';
  // Duplicate/unknown/not-found responses do not prove an earlier attempt failed.
  if (
    [
      '091',
      '016',
      '010',
      '011',
      '012',
      '013',
      '017',
      '018',
      '020',
      '021',
      '022',
      '023',
      '024',
      '030',
    ].includes(code)
  )
    return 'FAILED';
  return 'PENDING';
}
