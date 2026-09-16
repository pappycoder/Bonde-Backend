import { createHmac } from 'node:crypto';
import { vi } from 'vitest';
import type {
  CreateVirtualAccountParams,
  InitiateTransferParams,
  TransferData,
  VirtualAccountData,
  VirtualCardData,
  VirtualCardTransactionData,
} from '../src/modules/flutterwave/flutterwave.types.js';
import type { FlutterwaveGateway } from '../src/modules/flutterwave/flutterwave.client.js';

/**
 * In-memory `FlutterwaveGateway` used by e2e suites (booted via
 * `bootE2EApp({ overrides: [{ token: FLUTTERWAVE_CLIENT, useValue: stub }] })`).
 * Cards track a running `balance` so fund/withdraw/sync flows behave like the
 * real provider; every method is a `vi.fn` so suites can assert call args or
 * replace mock implementations per-test.
 */
export function makeFlutterwaveStub() {
  let nextId = 1;
  let cardBalance = 0;

  const baseCardData = (overrides: Partial<VirtualCardData> = {}): VirtualCardData => ({
    id: 'fw_card_1',
    amount: cardBalance,
    currency: 'NGN',
    cardPan: '************8381',
    maskedPan: '************8381',
    expiryMonth: '12',
    expiryYear: '29',
    cvv: '123',
    nameOnCard: 'AMINA SULE',
    isActive: true,
    createdAt: new Date().toISOString(),
    ...overrides,
  });

  const stub: FlutterwaveGateway = {
    createVirtualAccount: vi.fn(
      async (params: CreateVirtualAccountParams): Promise<VirtualAccountData> => ({
        id: nextId++,
        orderRef: `OR_${nextId - 1}`,
        accountNumber: '0123456789',
        bankName: 'Wema Bank',
        accountName: 'AMINA SULE',
        currency: params.currency,
        isPermanent: params.isPermanent,
        expiryDate: '2026-10-01T00:00:00.000Z',
        txRef: params.txRef,
        status: 'ACTIVE',
      }),
    ),

    initiateTransfer: vi.fn(async (params: InitiateTransferParams): Promise<TransferData> => ({
      id: nextId++,
      reference: params.reference,
      status: 'NEW',
      amount: params.amount,
      currency: params.currency,
      fee: 0,
      narration: params.narration,
    })),

    getTransfer: vi.fn(async (transferId: number): Promise<TransferData> => ({
      id: transferId,
      reference: `fw_tx_${transferId}`,
      status: 'PENDING',
      amount: 0,
      currency: 'NGN',
      fee: 0,
    })),

    createCard: vi.fn(async (params: { amount: number }): Promise<VirtualCardData> => {
      cardBalance = params.amount;
      return baseCardData({ cardPan: '5399838383838381', maskedPan: '************8381' });
    }),

    fundCard: vi.fn(async (_cardId: string, amount: string): Promise<VirtualCardData> => {
      cardBalance += Number(amount);
      return baseCardData();
    }),

    withdrawFromCard: vi.fn(async (_cardId: string, amount: string): Promise<VirtualCardData> => {
      cardBalance -= Number(amount);
      return baseCardData();
    }),

    terminateCard: vi.fn(async (): Promise<VirtualCardData> => baseCardData()),

    blockCard: vi.fn(async () => undefined),

    unblockCard: vi.fn(async () => undefined),

    getCard: vi.fn(async (): Promise<VirtualCardData> => baseCardData()),

    listCardTransactions: vi.fn(async (): Promise<VirtualCardTransactionData[]> => []),
  };

  return { stub, getBalance: () => cardBalance };
}

/** Base64 HMAC-SHA256 signature for a webhook raw body (Flutterwave v3 scheme). */
export function webhookSignature(raw: Buffer, secret: string): string {
  return createHmac('sha256', secret).update(raw).digest('base64');
}
