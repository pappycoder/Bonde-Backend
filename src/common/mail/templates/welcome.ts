import { emailLayout } from './layout.js';
import { esc, infoRow, lead } from './parts.js';
import type { EmailDoc } from './types.js';

export interface WelcomeEmailInput {
  firstName: string;
  accountNumber: string | null;
}

const NEXT_STEPS = [
  'Set spending limits and spend locks on your cards',
  'Restrict a card to the merchants you choose',
  'Track every transaction in the Bonde app',
];

/**
 * Sent right after the welcome email verification completes and the Bonde
 * account + wallet are provisioned. Best-effort: a delivery failure never
 * fails the verification request.
 */
export function welcomeEmail(input: WelcomeEmailInput): EmailDoc {
  const first = input.firstName.trim() || 'there';
  const rows = `<table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" style="margin:4px 0 0">
${infoRow('Account number', input.accountNumber)}
</table>`;

  return {
    subject: 'Welcome to Bonde',
    html: emailLayout({
      preheader: `Welcome to Bonde, ${first} — your account is ready.`,
      headline: `Welcome to Bonde, ${esc(first)}`,
      eyebrow: 'You’re in',
      body:
        lead(
          'Your account has been created and is ready to use. Here’s everything you need to get going.',
        ) +
        rows +
        `<div style="margin:8px 0 4px;font-size:15px;font-weight:700;color:#101828">What you can do now</div>` +
        `<ul style="margin:0 0 16px;padding:0 0 0 20px;font-size:15px;line-height:1.6;color:#344054">
${NEXT_STEPS.map((s) => `<li>${esc(s)}</li>`).join('\n')}
        </ul>`,
    }),
  };
}
