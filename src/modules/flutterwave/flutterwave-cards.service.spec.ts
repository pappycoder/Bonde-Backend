import { describe, expect, it, vi } from 'vitest';
import { FlutterwaveCardsService, type IssuedCard } from './flutterwave-cards.service.js';
import type { FlutterwaveGateway } from './flutterwave.client.js';
import { CardCredentialEncryptor } from './flutterwave-credential-crypto.js';
import type { VirtualCardData } from './flutterwave.types.js';

const CARD: VirtualCardData = {
  id: 'fw_card_1',
  amount: 5000,
  currency: 'NGN',
  cardPan: '************4242',
  maskedPan: '************4242',
  expiryMonth: '12',
  expiryYear: '29',
  cvv: '123',
  nameOnCard: 'AMINA SULE',
  isActive: true,
  createdAt: '2026-09-01T00:00:00.000Z',
};

function makeService(client: Partial<FlutterwaveGateway> = {}) {
  const encryptor: CardCredentialEncryptor = {
    encryptPan: vi.fn((pan) => `enc::pan::${pan}`),
    encryptCvv: vi.fn((cvv) => `enc::cvv::${cvv}`),
    decrypt: vi.fn(() => ({ pan: '5399838383838381', cvv: '123' })),
  };
  const service = new FlutterwaveCardsService(client as never, encryptor);
  return { service, encryptor };
}

describe('FlutterwaveCardsService', () => {
  describe('issueCard', () => {
    it('normalizes and encrypts credentials when the provider returns the full PAN', async () => {
      const fullPan: VirtualCardData = { ...CARD, cardPan: '5399838383838381' };
      const { service, encryptor } = makeService({ createCard: vi.fn(async () => fullPan) });

      const result: IssuedCard = await service.issueCard({
        currency: 'NGN',
        amount: 5000,
        debitCurrency: 'NGN',
        billingName: 'Amina Sule',
        billingAddress: '',
        billingCity: '',
        billingState: '',
        billingPostalCode: '',
        email: 'me@bonde.app',
      });

      expect(result).toMatchObject({
        providerCardId: 'fw_card_1',
        cardNumberLast4: '8381',
        currency: 'NGN',
        balance: '5000.00',
        status: 'ACTIVE',
      });
      expect(encryptor.encryptPan).toHaveBeenCalledWith('5399838383838381');
      expect(encryptor.encryptCvv).toHaveBeenCalledWith('123');
      expect(result.cardNumberEncrypted).toBe('enc::pan::5399838383838381');
      expect(result.cardCvvEncrypted).toBe('enc::cvv::123');
    });

    it('does not attempt to encrypt when the provider returns a masked PAN (read-back)', async () => {
      const { service, encryptor } = makeService({ createCard: vi.fn(async () => CARD) });
      const result = await service.issueCard({
        currency: 'NGN',
        amount: 5000,
        debitCurrency: 'NGN',
        billingName: 'x',
        billingAddress: '',
        billingCity: '',
        billingState: '',
        billingPostalCode: '',
        email: 'me@bonde.app',
      });
      expect(result.cardNumberEncrypted).toBeUndefined();
      expect(result.cardCvvEncrypted).toBeUndefined();
      expect(encryptor.encryptPan).not.toHaveBeenCalled();
      expect(result.cardNumberLast4).toBe('4242');
    });

    it('maps inactive cards to INACTIVE status', async () => {
      const { service } = makeService({
        createCard: vi.fn(async () => ({ ...CARD, isActive: false })),
      });
      const result = await service.issueCard({
        currency: 'NGN',
        amount: 5000,
        debitCurrency: 'NGN',
        billingName: 'x',
        billingAddress: '',
        billingCity: '',
        billingState: '',
        billingPostalCode: '',
        email: 'me@bonde.app',
      });
      expect(result.status).toBe('INACTIVE');
    });

    it('normalizes two-digit expiry years into full-year dates', async () => {
      const { service } = makeService({ createCard: vi.fn(async () => CARD) });
      const result = await service.issueCard({
        currency: 'NGN',
        amount: 5000,
        debitCurrency: 'NGN',
        billingName: 'x',
        billingAddress: '',
        billingCity: '',
        billingState: '',
        billingPostalCode: '',
        email: 'me@bonde.app',
      });
      expect(result.expirationDate.getUTCFullYear()).toBe(2029);
    });
  });

  describe('fundCard / getCard', () => {
    it('normalizes the read-back balance as a fixed 2dp string', async () => {
      const { service } = makeService({
        fundCard: vi.fn(async () => ({ ...CARD, amount: 7500 })),
        getCard: vi.fn(async () => ({ ...CARD, amount: 2500 })),
      });
      const funded = await service.fundCard({ providerCardId: 'fw_card_1', amount: '2500' });
      expect(funded.balance).toBe('7500.00');

      const fetched = await service.getCard('fw_card_1');
      expect(fetched.balance).toBe('2500.00');
    });
  });

  describe('decryptCredentials', () => {
    it('delegates to the encryptor without exposing it to callers', () => {
      const { service, encryptor } = makeService();
      expect(service.decryptCredentials('enc::pan::x', 'enc::cvv::y')).toEqual({
        pan: '5399838383838381',
        cvv: '123',
      });
      expect(encryptor.decrypt).toHaveBeenCalledWith('enc::pan::x', 'enc::cvv::y');
    });
  });
});
