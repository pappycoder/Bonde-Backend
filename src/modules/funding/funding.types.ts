/**
 * Funding surface types: per-user deposit accounts, withdrawal requests, and
 * the provider webhook handler results.
 */

export interface DepositAccountView {
  accountNumber: string;
  bankName: string;
  accountName: string | null;
  currency: string;
  /** `true` for static (permanent) VAs provisioned once identity is present. */
  isPermanent: boolean;
  /** ISO timestamp for dynamic VAs — present only when the account expires. */
  expiresAt: string | null;
}

export interface WithdrawalRequestInput {
  amount: string;
  accountNumber: string;
  bankCode: string;
  currency?: string;
  narration?: string;
}

export type WebhookHandledResult =
  | { status: 'processed'; reference: string }
  | { status: 'duplicate'; reference: string }
  | { status: 'ignored'; reference: string };
