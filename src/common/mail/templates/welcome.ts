import { emailLayout } from './layout.js';
import type { EmailSection } from './sections.js';
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
 *
 * `firstName` is passed through raw — the layout escapes it once. Pre-escaping
 * here would double-encode anything like "Ben & Jerry".
 */
export function welcomeEmail(input: WelcomeEmailInput): EmailDoc {
  const first = input.firstName.trim() || 'there';
  const sections: EmailSection[] = [
    {
      kind: 'lead',
      text: 'Your account has been created and is ready to use. Here’s everything you need to get going.',
    },
    { kind: 'facts', rows: [{ label: 'Account number', value: input.accountNumber }] },
    { kind: 'paragraph', text: 'What you can do now' },
    { kind: 'bullets', items: NEXT_STEPS },
  ];

  return {
    subject: 'Welcome to Bonde',
    html: emailLayout({
      preheader: `Welcome to Bonde, ${first} — your account is ready.`,
      headline: `Welcome to Bonde, ${first}`,
      eyebrow: 'You’re in',
      sections,
    }),
  };
}
