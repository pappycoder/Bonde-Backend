import type {
  ApprovalStatus,
  Transaction,
  TransactionStatus,
  TransactionType,
} from '@prisma/client';
import { money } from '../../common/money/money.js';

/** UI-legible transaction status derived from the raw status + approval flow. */
export type UiTxStatus = 'completed' | 'processing' | 'pending' | 'failed' | 'flagged';
/** Wallet-style transaction type label (lowercase). */
export type UiTxType = 'deposit' | 'withdrawal' | 'transfer' | 'payment';

/**
 * Legacy-status mapping used by the admin console:
 * - `FAIL` is always failed.
 * - `SUCCESS` is completed, unless a threshold warning elevates it to flagged
 *   for manual review.
 * - `PENDING` becomes processing while approval is in flight, pending once
 *   approved (awaiting settlement), denied → failed, and flagged when a
 *   threshold warning fired.
 */
export function deriveTxStatus(tx: {
  status: TransactionStatus;
  approvalStatus: ApprovalStatus;
  thresholdWarning: boolean;
}): UiTxStatus {
  if (tx.status === 'FAIL') return 'failed';
  if (tx.status === 'SUCCESS') return tx.thresholdWarning ? 'flagged' : 'completed';
  if (tx.approvalStatus === 'DECLINED') return 'failed';
  if (tx.thresholdWarning) return 'flagged';
  return tx.approvalStatus === 'APPROVED' ? 'pending' : 'processing';
}

/** Human-readable channel the movement landed through. */
export function txMethod(tx: {
  type: TransactionType;
  cardId: string | null;
  cardNumberLast4?: string | null;
}): string {
  if (tx.cardId) return `Card •••• ${tx.cardNumberLast4 ?? '••••'}`;
  switch (tx.type) {
    case 'DEPOSIT':
    case 'WITHDRAWAL':
      return 'Bank transfer';
    case 'PAYMENT':
      return 'Bonde Pay';
    case 'TRANSFER':
      return 'Wallet transfer';
  }
}

export interface AdminTxSummaryView {
  id: string;
  userId: string;
  type: UiTxType;
  status: UiTxStatus;
  approvalStatus: ApprovalStatus;
  amount: string;
  currency: string;
  method: string;
  description: string | null;
  thresholdWarning: boolean;
  isRecurring: boolean;
  createdAt: string;
}

interface AdminTxSummarySource extends Transaction {
  card?: { cardNumberLast4?: string | null } | null;
}

/**
 * Shared serializer for admin-facing transaction rows. Money is a fixed
 * 2-decimal string; `currency` prefers the wallet's currency when supplied.
 */
export function toAdminTxSummary(
  tx: AdminTxSummarySource,
  currencyOverride?: string,
): AdminTxSummaryView {
  return {
    id: tx.id,
    userId: tx.userId,
    type: tx.type.toLowerCase() as UiTxType,
    status: deriveTxStatus(tx),
    approvalStatus: tx.approvalStatus,
    amount: money(tx.amount),
    currency: currencyOverride ?? tx.currency,
    method: txMethod({
      type: tx.type,
      cardId: tx.cardId,
      cardNumberLast4: tx.card?.cardNumberLast4,
    }),
    description: tx.description,
    thresholdWarning: tx.thresholdWarning,
    isRecurring: tx.isRecurring,
    createdAt: tx.createdAt.toISOString(),
  };
}
