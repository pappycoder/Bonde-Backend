import { Inject, Injectable } from '@nestjs/common';
import type {
  CreateVirtualCardParams,
  VirtualCardData,
  VirtualCardTransactionData,
} from './flutterwave.types.js';
import { FLUTTERWAVE_CLIENT, type FlutterwaveGateway } from './flutterwave.client.js';
import { CardCredentialEncryptor } from './flutterwave-credential-crypto.js';

/**
 * Domain normalization of a provider-issued virtual card. Full PAN/CVV are
 * returned by the provider only at issuance, so `cardNumberEncrypted` /
 * `cardCvvEncrypted` are present solely on the issuance result — read-back
 * endpoints (fund/withdraw/terminate/get) carry the masked last-4 instead.
 */
export interface IssuedCard {
  providerCardId: string;
  cardNumberEncrypted?: string;
  cardCvvEncrypted?: string;
  cardNumberLast4: string;
  nameOnCard: string | null;
  cardType: string;
  currency: string;
  balance: string;
  status: string;
  expirationDate: Date;
}

export interface CardFundingInput {
  providerCardId: string;
  amount: string;
  debitCurrency?: 'NGN';
}

/**
 * Domain logic for Flutterwave virtual cards. Kept in the provider module so
 * the surface is reusable (any client surface can call it) while the per-feature
 * modules handle ownership, wallet movements, idempotency and notifications.
 */
@Injectable()
export class FlutterwaveCardsService {
  constructor(
    @Inject(FLUTTERWAVE_CLIENT) private readonly client: FlutterwaveGateway,
    private readonly encryptor: CardCredentialEncryptor,
  ) {}

  /**
   * Issue a prefunded virtual card. The PAN + CVV returned by the provider are
   * encrypted immediately and never surfaced to callers.
   */
  async issueCard(input: CreateVirtualCardParams): Promise<IssuedCard> {
    const card = await this.client.createCard(input);
    return this.normalize(card);
  }

  async fundCard(input: CardFundingInput): Promise<IssuedCard> {
    const card = await this.client.fundCard(
      input.providerCardId,
      input.amount,
      input.debitCurrency,
    );
    return this.normalize(card);
  }

  async withdrawFromCard(providerCardId: string, amount: string): Promise<IssuedCard> {
    const card = await this.client.withdrawFromCard(providerCardId, amount);
    return this.normalize(card);
  }

  async terminateCard(providerCardId: string): Promise<IssuedCard> {
    const card = await this.client.terminateCard(providerCardId);
    return this.normalize(card);
  }

  async blockCard(providerCardId: string): Promise<void> {
    await this.client.blockCard(providerCardId);
  }

  async unblockCard(providerCardId: string): Promise<void> {
    await this.client.unblockCard(providerCardId);
  }

  async getCard(providerCardId: string): Promise<IssuedCard> {
    const card = await this.client.getCard(providerCardId);
    return this.normalize(card);
  }

  async listCardTransactions(providerCardId: string): Promise<VirtualCardTransactionData[]> {
    return this.client.listCardTransactions(providerCardId);
  }

  /**
   * Internal-only accessor for server-side payment channels (the app never
   * exposes PAN/CVV over the wire). Resolves the encrypted credentials of a
   * locally stored issued card.
   */
  decryptCredentials(encryptedPan: string, encryptedCvv?: string) {
    return this.encryptor.decrypt(encryptedPan, encryptedCvv);
  }

  private normalize(card: VirtualCardData): IssuedCard {
    const isFullPan = card.cardPan.length > 4 && !card.cardPan.includes('*');
    const result: IssuedCard = {
      providerCardId: card.id,
      cardNumberLast4: card.cardPan.slice(-4),
      nameOnCard: card.nameOnCard ?? null,
      cardType: 'virtual',
      currency: card.currency,
      balance: RedactionUtils.decimalToFixed(card.amount),
      status: card.isActive ? 'ACTIVE' : 'INACTIVE',
      expirationDate: RedactionUtils.expiryDate(card.expiryMonth, card.expiryYear),
    };
    if (isFullPan) {
      result.cardNumberEncrypted = this.encryptor.encryptPan(card.cardPan);
      result.cardCvvEncrypted = this.encryptor.encryptCvv(card.cvv);
    }
    return result;
  }
}

/**
 * Small internal helpers kept out of the injectable so the service stays
 * readable. Referenced statically; see notes above each method.
 */
const RedactionUtils = {
  decimalToFixed(value: number): string {
    return value.toFixed(2);
  },
  expiryDate(month: string, year: string): Date {
    const m = Number(month);
    const y = Number(year);
    // Provider year is often two-digit ("29") — normalize to a full year.
    return new Date(Date.UTC(y >= 100 ? y : 2000 + y, m, 0, 23, 59, 59, 999));
  },
};
