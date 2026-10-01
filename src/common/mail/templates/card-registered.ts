import { emailLayout } from './layout.js';
import type { EmailSection } from './sections.js';
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
  const merchantValue =
    input.merchants.length > 0
      ? input.merchants
          .map((m) => `${m.merchantName}${m.merchantCode ? ` (${m.merchantCode})` : ''}`)
          .join(', ')
      : 'None';

  const sections: EmailSection[] = [
    { kind: 'lead', text: `Hi ${first}, your new card is ready to use.` },
    {
      kind: 'facts',
      rows: [
        { label: 'Card', value: `•••• ${input.last4}` },
        { label: 'Nickname', value: input.nickname },
        { label: 'Single-transaction limit', value: formatLimit(input.maxSpendLimit) },
        { label: 'Monthly limit', value: formatLimit(input.monthlyLimit) },
        { label: 'Restricted to these merchants', value: merchantValue },
      ],
    },
    {
      kind: 'note',
      text: 'Merchant restrictions are enforced at the provider before a transaction is approved.',
    },
  ];

  return {
    subject: `Your Bonde card ending in ${input.last4} is ready`,
    html: emailLayout({
      preheader: `Your new Bonde card ending in ${input.last4} is ready to use.`,
      headline: 'Your card is ready',
      eyebrow: 'Card issued',
      sections,
    }),
  };
}

function formatLimit(value: string | null): string | null {
  if (!value) return null;
  return `NGN ${value}`;
}
