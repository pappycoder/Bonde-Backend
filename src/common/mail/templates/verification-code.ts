import { codeBox } from './code-box.js';
import { emailLayout } from './layout.js';
import { lead, note } from './parts.js';
import type { EmailDoc } from './types.js';

export type VerificationPurpose = 'verify-email' | 'login' | 'recovery' | 'two-factor';

const PURPOSE_COPY: Record<VerificationPurpose, { headline: string; body: string }> = {
  'verify-email': {
    headline: 'Confirm it’s you',
    body: 'Enter the code below to verify your Bonde email address.',
  },
  login: {
    headline: 'Your sign-in code',
    body: 'Use the code below to finish signing in to Bonde.',
  },
  recovery: {
    headline: 'We’re here to help',
    body: 'Enter the code below to reset your Bonde password.',
  },
  'two-factor': {
    headline: 'Double-check time',
    body: 'Enter the code below to complete your two-factor sign-in.',
  },
};

/**
 * One-time verification code email. These are the only fail-closed emails:
 * they carry credentials, so a delivery failure must void the code (503).
 */
export function verificationCodeEmail(
  code: string,
  purpose: VerificationPurpose = 'verify-email',
): EmailDoc {
  const copy = PURPOSE_COPY[purpose];
  const subject =
    purpose === 'verify-email' ? 'Your Bonde verification code' : `Your Bonde sign-in code`;

  return {
    subject,
    html: emailLayout({
      preheader: `Your Bonde code is ${code}`,
      headline: copy.headline,
      body:
        lead(copy.body) +
        codeBox(code) +
        note(
          'This code expires in 5 minutes. If you didn’t request it, you can safely ignore this email.',
        ),
    }),
  };
}
