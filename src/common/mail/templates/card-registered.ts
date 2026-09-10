import { emailLayout } from './layout.js';
import { esc, infoRow, lead, note } from './parts.js';
import type { EmailDoc } from './types.js';

export interface CardMerchantSummary {
  merchantName: string;
  merchantCode: string | null;
}

export interface CardRegisteredEmailInput {
  firstName: string;
  last4: string;
  nickname: string | null;
  maxSpendLimit: string | null;
  monthlyLimit: string | null;
  merchants: CardMerchantSummary[];
}

/**
 * Sent when a card is created. Best-effort: card creation must not fail if
 * email delivery fails. `maxSpendLimit`/`monthlyLimit` come in normalized 2dp
 * money form (e.g. "2500.00").
 */
export function cardRegisteredEmail(input: CardRegisteredEmailInput): EmailDoc {
  const first = input.firstName.trim() || 'there';
  const merchantLabel = 'Restricted to these merchants';
  const merchantValue =
    input.merchants.length > 0
      ? input.merchants
          .map((m) => `${m.merchantName}${m.merchantCode ? ` (${m.merchantCode})` : ''}`)
          .join(', ')
      : 'None';

  return {
    subject: `Your Bonde card ending in ${input.last4} is ready`,
    html: emailLayout({
      preheader: `Your new Bonde card ending in ${input.last4} is ready to use.`,
      headline: 'Your card is ready',
      eyebrow: 'Card issued',
      body:
        lead(`Hi ${esc(first)}, your new card is ready to use.`) +
        `<table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" style="margin:4px 0 0">
${infoRow('Card', `•••• ${input.last4}`)}
${infoRow('Nickname', input.nickname)}
${infoRow('Single-transaction limit', formatLimit(input.maxSpendLimit))}
${infoRow('Monthly limit', formatLimit(input.monthlyLimit))}
${infoRow(merchantLabel, merchantValue)}
</table>` +
        note(
          'Merchant restrictions are enforced at the provider before a transaction is approved.',
        ),
    }),
  };
}

function formatLimit(value: string | null): string | null {
  if (!value) return null;
  return `NGN ${value}`;
}
