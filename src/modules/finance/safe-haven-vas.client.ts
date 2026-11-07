import {
  BadGatewayException,
  BadRequestException,
  HttpException,
  Injectable,
  ServiceUnavailableException,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { Prisma, type ServiceQuote } from '@prisma/client';
import type { AppConfig } from '../../config/configuration.js';
import { ProviderError, SafeHavenClient } from './providers.js';
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
export interface ServicePlan {
  serviceId: string;
  code: string;
  name: string;
  amount: string;
  currency: string;
  providerCategoryId: string;
  providerPlanCode: string;
}
export interface ServiceOutcome {
  status: 'SUCCEEDED' | 'FAILED' | 'PENDING';
  reference: string;
  amount?: string;
  beneficiary?: string;
  categoryId?: string;
  transactionId?: string;
}

function rows(value: unknown) {
  if (!Array.isArray(value))
    throw new BadGatewayException('Service catalog is temporarily unavailable.');
  return value.map(object);
}
function money(value: unknown): string | undefined {
  const raw = typeof value === 'number' || typeof value === 'string' ? String(value) : '';
  return /^\d{1,12}(\.\d{1,2})?$/.test(raw) ? new Prisma.Decimal(raw).toFixed(2) : undefined;
}

/** Only authenticated lookups settle funds; a successful POST alone is not delivery evidence. */
export function vasOutcome(value: unknown, requestedReference: string): ServiceOutcome {
  const data = object(value);
  const external = string(data.externalReference);
  const reference = external || requestedReference;
  const state = string(data.transactionStatus).toLowerCase();
  const payment = string(data.paymentStatus).toUpperCase();
  let status: ServiceOutcome['status'] = 'PENDING';
  if (reference === requestedReference && string(data._id)) {
    if (state === 'successful' && payment === 'DEBITED') status = 'SUCCEEDED';
    // A failed vend still debited at the supplier must stay held until reversal is confirmed.
    if (['failed', 'reversed'].includes(state) && payment === 'REVERSED') status = 'FAILED';
  }
  return {
    status,
    reference,
    amount: money(data.transactionAmount),
    beneficiary: string(data.receiverNumber),
    categoryId:
      typeof data.serviceCategoryId === 'string'
        ? data.serviceCategoryId
        : string(object(data.serviceCategoryId)._id),
    transactionId: string(data._id) || undefined,
  };
}

@Injectable()
export class SafeHavenVasClient {
  readonly name = 'SAFE_HAVEN';
  constructor(
    private readonly client: SafeHavenClient,
    private readonly config: ConfigService<AppConfig, true>,
  ) {}
  get environment() {
    return this.config.get('finance').environment;
  }
  assertEnabled() {
    const c = this.config.get('finance');
    const expected =
      c.environment === 'production'
        ? 'https://api.safehavenmfb.com'
        : 'https://api.sandbox.safehavenmfb.com';
    if (
      !this.config.get('shopping').servicesEnabled ||
      !c.safeHavenClientId ||
      !c.safeHavenIssuer ||
      !c.safeHavenPrivateKey ||
      c.safeHavenBaseUrl !== expected
    )
      throw new ServiceUnavailableException('Safe Haven service purchases are not configured.');
  }
  assertPurchasesEnabled() {
    this.assertEnabled();
    const c = this.config.get('finance');
    if (
      !/^\d{10}$/.test(c.treasuryAccountNumber) ||
      (c.environment === 'production' &&
        (!c.enabled || !c.feesVerified || !c.treasuryVerified || !c.jobToken))
    )
      throw new ServiceUnavailableException(
        'Service purchase funding and finance approvals are not configured.',
      );
  }
  private async read(path: string, method = 'GET', body?: unknown, signal?: AbortSignal) {
    try {
      return await this.client.call(path, method, body, signal);
    } catch (error) {
      if (error instanceof HttpException) throw error;
      if (
        path === '/vas/verify' &&
        error instanceof ProviderError &&
        error.definitive &&
        [400, 422].includes(error.status)
      )
        throw new BadRequestException('Check the cable account number and try again.');
      throw new BadGatewayException(
        'Safe Haven services are temporarily unavailable. Please retry.',
      );
    }
  }
  private async categories(signal?: AbortSignal, requestedKind?: 'DATA' | 'CABLETV') {
    this.assertEnabled();
    const services = rows(await this.read('/vas/services', 'GET', undefined, signal));
    const supported: { id: string; categoryId: string }[] = [];
    for (const kind of ['DATA', 'CABLETV']) {
      if (requestedKind && requestedKind !== kind) continue;
      const service = services.find((r) => r.identifier === kind && string(r._id));
      if (!service) continue;
      const categories = rows(
        await this.read(
          `/vas/service/${encodeURIComponent(string(service._id))}/service-categories`,
          'GET',
          undefined,
          signal,
        ),
      );
      for (const category of categories) {
        const identifier = string(category.identifier).toLowerCase();
        const network = identifier === '9mobile' ? 'etisalat' : identifier;
        const id = kind === 'DATA' ? `${network}-data` : network;
        if (
          (serviceIds as readonly string[]).includes(id) &&
          string(category._id) &&
          !supported.some((r) => r.id === id)
        )
          supported.push({ id, categoryId: string(category._id) });
      }
    }
    return supported;
  }
  async catalog(signal?: AbortSignal) {
    return (await this.categories(signal)).map(({ id }) => ({
      id,
      category: isTv(id) ? 'CABLE_TV' : 'DATA',
      autoRenew: false,
    }));
  }
  private async category(serviceId: string, signal?: AbortSignal) {
    if (!(serviceIds as readonly string[]).includes(serviceId))
      throw new ServiceUnavailableException('This service is not supported.');
    const category = (await this.categories(signal, isTv(serviceId) ? 'CABLETV' : 'DATA')).find(
      (r) => r.id === serviceId,
    );
    if (!category)
      throw new ServiceUnavailableException(
        'This service is currently unavailable from Safe Haven.',
      );
    return category;
  }
  async plans(serviceId: string, signal?: AbortSignal): Promise<ServicePlan[]> {
    const category = await this.category(serviceId, signal);
    const products = rows(
      await this.read(
        `/vas/service-category/${encodeURIComponent(category.categoryId)}/products`,
        'GET',
        undefined,
        signal,
      ),
    );
    return products.flatMap((p) => {
      const amount = money(p.amount);
      const code = string(p.bundleCode);
      if (
        p.isAmountFixed !== true ||
        !amount ||
        new Prisma.Decimal(amount).lte(0) ||
        !code ||
        code.length > 100 ||
        !string(p.name)
      )
        return [];
      return [
        {
          serviceId,
          code,
          name: string(p.name),
          amount,
          currency: 'NGN',
          providerCategoryId: category.categoryId,
          providerPlanCode: code,
        },
      ];
    });
  }
  async verify(serviceId: string, beneficiary: string, signal?: AbortSignal) {
    const category = await this.category(serviceId, signal);
    if (!isTv(serviceId)) return { name: null, verified: false, verification: 'PHONE_FORMAT_ONLY' };
    const data = object(
      await this.read(
        '/vas/verify',
        'POST',
        { serviceCategoryId: category.categoryId, entityNumber: beneficiary },
        signal,
      ),
    );
    if (!string(data.name).trim())
      throw new BadGatewayException(
        'Could not verify this service account. Check the number and try again.',
      );
    return { name: string(data.name), verified: true, verification: 'PROVIDER' };
  }
  async balance() {
    this.assertPurchasesEnabled();
    const c = this.config.get('finance');
    // Resolve the treasury by number; the account detail endpoint expects its provider _id.
    for (let page = 0; page < 20; page++) {
      const accounts = rows(await this.read(`/accounts?isSubAccount=false&page=${page}&limit=100`));
      const account = accounts.find((r) => r.accountNumber === c.treasuryAccountNumber);
      if (account) {
        if (
          account.currencyCode !== 'NGN' ||
          account.canDebit !== true ||
          account.status !== 'Active'
        )
          break;
        const raw = account.accountBalance;
        if (
          (typeof raw !== 'number' && typeof raw !== 'string') ||
          !Number.isFinite(Number(raw)) ||
          Number(raw) < 0
        )
          break;
        return new Prisma.Decimal(String(raw)).toDecimalPlaces(6);
      }
      if (accounts.length < 100) break;
    }
    throw new BadGatewayException('Could not verify the Safe Haven treasury balance.');
  }
  async purchase(reference: string, quote: ServiceQuote) {
    this.assertPurchasesEnabled();
    if (
      quote.provider !== this.name ||
      quote.environment !== this.environment ||
      !quote.providerCategoryId ||
      !quote.providerPlanCode
    )
      throw new ServiceUnavailableException('Request a fresh Safe Haven quote.');
    await this.client.call(isTv(quote.serviceId) ? '/vas/pay/cable-tv' : '/vas/pay/data', 'POST', {
      serviceCategoryId: quote.providerCategoryId,
      bundleCode: quote.providerPlanCode,
      amount: quote.amount.toNumber(),
      channel: 'WEB',
      debitAccountNumber: this.config.get('finance').treasuryAccountNumber,
      externalReference: reference,
      ...(isTv(quote.serviceId)
        ? { cardNumber: quote.beneficiary }
        : { phoneNumber: quote.beneficiary }),
    });
  }
  async requery(reference: string): Promise<ServiceOutcome> {
    this.assertEnabled();
    return vasOutcome(
      await this.read(`/vas/transaction/${encodeURIComponent(reference)}`),
      reference,
    );
  }
}
