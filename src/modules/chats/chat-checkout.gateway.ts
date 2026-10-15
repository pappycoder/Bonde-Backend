import { Injectable, ServiceUnavailableException } from '@nestjs/common';
import type { ChatCheckoutDto, StartChatCheckoutDto } from './chat-checkout.dto.js';

export type CheckoutProgress = Pick<ChatCheckoutDto, 'status' | 'cardId' | 'reference'>;
/** Trusted integration boundary. Implementations MUST deduplicate all issuance
 * and checkout by transactionId, enforce issuer/card rules, reconcile the actual
 * transaction/payment, and close a ONE_TIME card only after confirmed success.
 * ONE_TIME must issue a real card limited to this merchant, spendingLimit and
 * one successful use. Never use the local development card as a live issuer.
 * status/cancel must report actual provider outcomes (a cancellation request
 * is not proof of cancellation). Recovery must use the same idempotency key.
 */
export abstract class ChatCheckoutGateway {
  abstract assertConfigured(): void;
  abstract start(input: {
    userId: string;
    transactionId: string;
    method: StartChatCheckoutDto['method'];
    cardId?: string;
    amount: string;
    currency: string;
    merchant: string;
    spendingLimit: string;
  }): Promise<CheckoutProgress>;
  abstract status(transactionId: string): Promise<CheckoutProgress>;
  abstract cancel(transactionId: string): Promise<CheckoutProgress>;
}
@Injectable()
export class UnconfiguredChatCheckoutGateway extends ChatCheckoutGateway {
  assertConfigured(): never {
    throw new ServiceUnavailableException(
      'Checkout is not available yet. Your purchase approval has been saved.',
    );
  }
  async start(): Promise<CheckoutProgress> {
    return this.assertConfigured();
  }
  async status(): Promise<CheckoutProgress> {
    return this.assertConfigured();
  }
  async cancel(): Promise<CheckoutProgress> {
    return this.assertConfigured();
  }
}
