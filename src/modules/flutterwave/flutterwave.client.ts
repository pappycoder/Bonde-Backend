import { Injectable } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import type { AppConfig } from '../../config/configuration.js';
import { FlutterwaveError } from './flutterwave.errors.js';
import {
  type CreateVirtualAccountParams,
  type CreateVirtualCardParams,
  type FlutterwaveApiResponse,
  type InitiateTransferParams,
  type TransferData,
  type VirtualAccountData,
  type VirtualCardData,
  type VirtualCardTransactionData,
} from './flutterwave.types.js';

/**
 * Provider surface the rest of the app talks to. Injected under the
 * `FLUTTERWAVE_CLIENT` token — e2e swaps it for a fake while the real
 * domain services run on top.
 */
export interface FlutterwaveGateway {
  createVirtualAccount(params: CreateVirtualAccountParams): Promise<VirtualAccountData>;
  initiateTransfer(params: InitiateTransferParams): Promise<TransferData>;
  getTransfer(transferId: number): Promise<TransferData>;
  createCard(params: CreateVirtualCardParams): Promise<VirtualCardData>;
  fundCard(cardId: string, amount: string, debitCurrency?: 'NGN'): Promise<VirtualCardData>;
  withdrawFromCard(cardId: string, amount: string): Promise<VirtualCardData>;
  terminateCard(cardId: string): Promise<VirtualCardData>;
  blockCard(cardId: string): Promise<void>;
  unblockCard(cardId: string): Promise<void>;
  getCard(cardId: string): Promise<VirtualCardData>;
  listCardTransactions(cardId: string): Promise<VirtualCardTransactionData[]>;
}

/** Binding token — tests replace it with an in-memory fake. */
export const FLUTTERWAVE_CLIENT = Symbol('FLUTTERWAVE_CLIENT');

const REQUEST_TIMEOUT_MS = 10_000;

/**
 * Minimal Flutterwave v3 REST client. Bearer-authenticated against the
 * configured secret key; every call carries a 10s timeout. This is the only
 * place in the app that talks to Flutterwave directly.
 */
@Injectable()
export class FlutterwaveClient implements FlutterwaveGateway {
  private readonly baseUrl: string;
  private readonly secretKey: string;

  constructor(config: ConfigService<AppConfig, true>) {
    const fw = config.get('flutterwave');
    this.baseUrl = fw.baseUrl.replace(/\/+$/, '');
    this.secretKey = fw.secretKey;
  }

  async createVirtualAccount(params: CreateVirtualAccountParams): Promise<VirtualAccountData> {
    const data = await this.request<{
      id: number;
      order_ref: string;
      account_number: string;
      bank_name: string;
      account_name?: string;
      currency: string;
      frequency: number | string;
      expiry_date?: string | null;
      is_permanent?: boolean;
      tx_ref?: string;
      flw_ref: string;
      status: string;
    }>('/virtual-account-numbers', {
      method: 'POST',
      body: {
        email: params.email,
        is_permanent: params.isPermanent,
        tx_ref: params.txRef,
        bank_code: params.bankCode,
        currency: params.currency,
        ...(params.firstName ? { firstname: params.firstName } : {}),
        ...(params.lastName ? { lastname: params.lastName } : {}),
        ...(params.narration ? { narration: params.narration } : {}),
        ...(params.phone ? { phone: params.phone } : {}),
        // Permanent VAs are opened with a zero amount; a positive amount is a
        // one-off funding of the account itself.
        ...(params.isPermanent ? { amount: params.amount ?? 0 } : {}),
        ...(params.bvn ? { bvn: params.bvn } : {}),
      },
    });
    return {
      id: data.id,
      orderRef: data.order_ref,
      accountNumber: data.account_number,
      bankName: data.bank_name,
      accountName: data.account_name,
      currency: data.currency,
      isPermanent: Boolean(data.is_permanent) || params.isPermanent,
      expiryDate: data.expiry_date,
      txRef: data.tx_ref,
      flwRef: data.flw_ref,
      status: data.status,
    };
  }

  async initiateTransfer(params: InitiateTransferParams): Promise<TransferData> {
    const data = await this.request<{
      id: number;
      reference: string;
      status: TransferData['status'];
      amount: number;
      currency: string;
      fee: number;
      narration?: string;
      complete_message?: string;
    }>('/transfers', {
      method: 'POST',
      body: {
        account_bank: params.accountBank,
        account_number: params.accountNumber,
        amount: params.amount,
        currency: params.currency,
        reference: params.reference,
        narration: params.narration,
        ...(params.debitCurrency ? { debit_currency: params.debitCurrency } : {}),
      },
    });
    return {
      id: data.id,
      reference: data.reference,
      status: data.status,
      amount: data.amount,
      currency: data.currency,
      fee: data.fee,
      narration: data.narration,
      complete_message: data.complete_message,
    };
  }

  async getTransfer(transferId: number): Promise<TransferData> {
    const data = await this.request<{
      id: number;
      reference: string;
      status: TransferData['status'];
      amount: number;
      currency: string;
      fee: number;
      narration?: string;
      complete_message?: string;
    }>(`/transfers/${transferId}`);
    return {
      id: data.id,
      reference: data.reference,
      status: data.status,
      amount: data.amount,
      currency: data.currency,
      fee: data.fee,
      narration: data.narration,
      complete_message: data.complete_message,
    };
  }

  async createCard(params: CreateVirtualCardParams): Promise<VirtualCardData> {
    const data = await this.request<{
      id: string;
      AccountId?: number;
      amount: number;
      currency: string;
      card_pan: string;
      masked_pan: string;
      city?: string;
      state?: string;
      address_1?: string;
      address_city?: string;
      address_state?: string;
      address_country?: string;
      expiry_month: string;
      expiry_year: string;
      cvv: string;
      card_brand?: string;
      card_tier?: string;
      name_on_card?: string;
      is_active: boolean;
      created_at: string;
    }>('/virtual-cards', {
      method: 'POST',
      body: {
        currency: params.currency,
        amount: params.amount,
        debit_currency: params.debitCurrency,
        billing_name: params.billingName,
        billing_address: params.billingAddress,
        billing_city: params.billingCity,
        billing_state: params.billingState,
        billing_postal_code: params.billingPostalCode,
        ...(params.firstName ? { first_name: params.firstName } : {}),
        ...(params.lastName ? { last_name: params.lastName } : {}),
        ...(params.email ? { email: params.email } : {}),
        ...(params.phone ? { phone: params.phone } : {}),
        ...(params.dateOfBirth ? { date_of_birth: params.dateOfBirth } : {}),
        ...(params.title ? { title: params.title } : {}),
        ...(params.gender ? { gender: params.gender } : {}),
        ...(params.callbackUrl ? { callback_url: params.callbackUrl } : {}),
      },
    });
    return this.toCardData(data);
  }

  async fundCard(cardId: string, amount: string, debitCurrency: 'NGN' = 'NGN') {
    const data = await this.request<CardCreatePayload>(`/virtual-cards/${cardId}/fund`, {
      method: 'POST',
      body: { debit_currency: debitCurrency, amount: Number(amount) },
    });
    return this.toCardData(data);
  }

  async withdrawFromCard(cardId: string, amount: string) {
    const data = await this.request<CardCreatePayload>(`/virtual-cards/${cardId}/withdraw`, {
      method: 'POST',
      body: { amount: Number(amount) },
    });
    return this.toCardData(data);
  }

  async terminateCard(cardId: string) {
    const data = await this.request<CardCreatePayload>(`/virtual-cards/${cardId}/terminate`, {
      method: 'POST',
    });
    return this.toCardData(data);
  }

  async blockCard(cardId: string): Promise<void> {
    await this.request<unknown>(`/virtual-cards/${cardId}/block`, { method: 'POST' });
  }

  async unblockCard(cardId: string): Promise<void> {
    await this.request<unknown>(`/virtual-cards/${cardId}/unblock`, { method: 'POST' });
  }

  async getCard(cardId: string) {
    const data = await this.request<CardCreatePayload>(`/virtual-cards/${cardId}`);
    return this.toCardData(data);
  }

  async listCardTransactions(cardId: string): Promise<VirtualCardTransactionData[]> {
    const data = await this.request<
      Array<{
        id: number;
        card_id?: string;
        amount: number;
        currency: string;
        status: string;
        reference?: string;
        tx_ref?: string;
        date_created?: string;
        created_at?: string;
        narration?: string;
        settlement?: number;
      }>
    >(`/virtual-cards/${cardId}/transactions`);
    return (data ?? []).map((txn) => ({
      id: txn.id,
      cardId: txn.card_id,
      amount: txn.amount,
      currency: txn.currency,
      status: txn.status,
      reference: txn.reference ?? txn.tx_ref,
      dateCreated: txn.date_created ?? txn.created_at,
      narration: txn.narration,
      settlement: txn.settlement,
    }));
  }

  // -------------------------------------------------------------------------
  // Internals
  // -------------------------------------------------------------------------

  private toCardData(data: CardCreatePayload): VirtualCardData {
    return {
      id: String(data.id),
      accountId: data.AccountId,
      amount: data.amount,
      currency: data.currency,
      cardPan: data.card_pan,
      maskedPan: data.masked_pan,
      city: data.city,
      state: data.state,
      address1: data.address_1,
      addressCity: data.address_city,
      addressState: data.address_state,
      addressCountry: data.address_country,
      expiryMonth: data.expiry_month,
      expiryYear: data.expiry_year,
      cvv: data.cvv,
      cardBrand: data.card_brand,
      cardTier: data.card_tier,
      nameOnCard: data.name_on_card,
      isActive: data.is_active,
      createdAt: data.created_at,
    };
  }

  private async request<T>(
    path: string,
    init: { method?: 'GET' | 'POST'; body?: Record<string, unknown> } = {},
  ): Promise<T> {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);
    try {
      const response = await fetch(`${this.baseUrl}${path}`, {
        method: init.method ?? 'GET',
        headers: {
          'content-type': 'application/json',
          authorization: `Bearer ${this.secretKey}`,
        },
        ...(init.body ? { body: JSON.stringify(init.body) } : {}),
        signal: controller.signal,
      });

      const payload = (await this.parseBody(response)) as
        FlutterwaveApiResponse<T> | { status?: string; message?: string; data?: unknown } | null;
      if (!response.ok) {
        throw this.toProviderError(response.status, payload);
      }
      if (payload?.status === 'error') {
        throw this.toProviderError(response.status, payload);
      }
      return (payload?.data ?? payload) as T;
    } catch (error) {
      if (error instanceof FlutterwaveError) throw error;
      const detail = error instanceof Error ? error.message : String(error);
      throw new FlutterwaveError('PROVIDER', `Flutterwave unreachable: ${detail}`);
    } finally {
      clearTimeout(timer);
    }
  }

  private async parseBody(response: Response): Promise<unknown | null> {
    try {
      return await response.json();
    } catch {
      return null;
    }
  }

  private toProviderError(
    status: number,
    payload: { message?: string; data?: { code?: string; message?: string } | unknown } | null,
  ): FlutterwaveError {
    const detail = this.messageOf(payload);
    if (status === 401) return new FlutterwaveError('CONFIG', detail);
    if (status === 400 || status === 422) return new FlutterwaveError('VALIDATION', detail);
    return new FlutterwaveError('PROVIDER', detail);
  }

  private messageOf(payload: { message?: string; data?: unknown } | null): string {
    const data = payload?.data;
    if (payload?.message) return `Flutterwave ${payload.message}`;
    if (data && typeof data === 'object' && 'message' in data) {
      return `Flutterwave ${String((data as { message: string }).message)}`;
    }
    return 'Flutterwave returned an error';
  }
}

interface CardCreatePayload {
  id: string | number;
  AccountId?: number;
  amount: number;
  currency: string;
  card_pan: string;
  masked_pan: string;
  city?: string;
  state?: string;
  address_1?: string;
  address_city?: string;
  address_state?: string;
  address_country?: string;
  expiry_month: string;
  expiry_year: string;
  cvv: string;
  card_brand?: string;
  card_tier?: string;
  name_on_card?: string;
  is_active: boolean;
  created_at: string;
}
