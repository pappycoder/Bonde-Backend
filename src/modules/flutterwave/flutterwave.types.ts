/**
 * Payload shapes for the Flutterwave v3 REST API (https://api.flutterwave.com/v3).
 * Minimal — we only model the fields this application uses.
 */

export interface FlutterwaveApiResponse<T> {
  status: 'success' | 'error';
  message: string;
  data: T;
}

// -- Virtual accounts --------------------------------------------------------

export interface CreateVirtualAccountParams {
  email: string;
  /** Dynamic (`false`) vs static/permanent (`true`, requires BVN/NIN in live). */
  isPermanent: boolean;
  txRef: string;
  bankCode: string;
  currency: string;
  firstName?: string;
  lastName?: string;
  narration?: string;
  /** Required for permanent VAs (amount to keep the account open). */
  amount?: number;
  bvn?: string;
  phone?: string;
}

export interface VirtualAccountData {
  id: number;
  orderRef: string;
  accountNumber: string;
  bankName: string;
  accountName?: string;
  currency: string;
  isPermanent: boolean;
  /** ISO 8601 — present for dynamic VAs (they expire). */
  expiryDate?: string | null;
  txRef?: string;
  flwRef?: string;
  status: string;
}

// -- Webhooks ----------------------------------------------------------------

export interface ChargeCompletedData {
  id: number;
  txRef?: string;
  flwRef?: string;
  amount: number;
  currency: string;
  status: string;
  paymentType?: string;
  customer?: { email?: string; phone_number?: string; name?: string } | null;
}

export interface TransferDisburseData {
  id: number;
  reference?: string;
  status: 'SUCCESSFUL' | 'FAILED' | 'PENDING';
  amount?: number;
  currency?: string;
  fee?: number;
  narration?: string;
  complete_message?: string;
}

export interface FlutterwaveWebhookEvent {
  /** e.g. `charge.completed`, `transfer.disburse`, `transfer.reversal`, `card_transaction`. */
  event: string;
  data: Record<string, unknown>;
}

// -- Transfers ---------------------------------------------------------------

export interface InitiateTransferParams {
  accountBank: string;
  accountNumber: string;
  amount: number;
  currency: string;
  reference: string;
  narration?: string;
  debitCurrency?: string;
}

export interface TransferData {
  id: number;
  reference: string;
  status: 'NEW' | 'PENDING' | 'SUCCESSFUL' | 'FAILED';
  amount: number;
  currency: string;
  fee: number;
  narration?: string;
  complete_message?: string;
}

// -- Virtual cards -----------------------------------------------------------

export interface CreateVirtualCardParams {
  currency: string;
  /** Prefund amount to load onto the card at issuance. */
  amount: number;
  debitCurrency: 'NGN';
  billingName: string;
  billingAddress: string;
  billingCity: string;
  billingState: string;
  billingPostalCode: string;
  firstName?: string;
  lastName?: string;
  email: string;
  phone?: string;
  dateOfBirth?: string;
  title?: string;
  gender?: string;
  callbackUrl?: string;
}

export interface VirtualCardData {
  id: string;
  accountId?: number;
  amount: number;
  currency: string;
  cardPan: string;
  maskedPan: string;
  city?: string;
  state?: string;
  address1?: string;
  addressCity?: string;
  addressState?: string;
  addressCountry?: string;
  expiryMonth: string;
  expiryYear: string;
  cvv: string;
  cardBrand?: string;
  cardTier?: string;
  nameOnCard?: string;
  isActive: boolean;
  createdAt: string;
}

export interface VirtualCardTransactionData {
  id: number;
  cardId?: string;
  amount: number;
  currency: string;
  status: 'successful' | 'failed' | 'pending' | string;
  reference?: string;
  txRef?: string;
  dateCreated?: string;
  created_at?: string;
  narration?: string;
  settlement?: number;
}
