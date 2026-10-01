import { emailLayout } from './layout.js';
import type { EmailSection } from './sections.js';
import type { EmailDoc } from './types.js';

/**
 * What an emailed code authorises. Only the purposes that actually reach
 * `ResendOtpSender` belong here:
 *
 * - `verify-email` — registration and resend-verification.
 * - `recovery` — forgot-password.
 *
 * Login is password-only and the second factor is TOTP, so neither sends an
 * email code. `login` / `two-factor` were kept in the union before this was
 * threaded end to end, which meant the copy below was reachable only by a
 * caller passing a purpose no code path ever supplies. Adding a purpose is a
 * deliberate act: wire the call site and its copy together.
 */
export type VerificationPurpose = 'verify-email' | 'recovery';

interface PurposeCopy {
  subject: string;
  headline: string;
  lead: string;
  /** Extra reassurance appended after the expiry note. */
  note: string;
}

const PURPOSE_COPY: Record<VerificationPurpose, PurposeCopy> = {
  'verify-email': {
    subject: 'Verify your email',
    headline: 'Verify your email',
    lead: 'Use the verification code below to confirm your email address and finish setting up your Bonde account.',
    note: 'This code expires in 5 minutes. If you didn’t request this code, you can safely ignore this email.',
  },
  recovery: {
    subject: 'Reset your Bonde password',
    headline: 'Reset your password',
    lead: 'We got a request to reset your Bonde password. Enter the code below to choose a new one.',
    note: 'This code expires in 5 minutes. If you didn’t request a reset, you can safely ignore this email.',
  },
};

/**
 * One-time code email — the only fail-closed template, because it carries a
 * credential: a delivery failure must void the code and answer 503.
 *
 * Each purpose gets its own subject and body copy. They used to collapse to a
 * single "verify your email" message for every flow, which meant a
 * password-reset request arrived looking like a signup confirmation.
 */
export function verificationCodeEmail(
  code: string,
  purpose: VerificationPurpose = 'verify-email',
): EmailDoc {
  const copy = PURPOSE_COPY[purpose];
  if (!copy) {
    // This is a credential-bearing email. A missing purpose used to render
    // `undefined` into the body, so a caller passing an unlisted flow shipped a
    // wrong-headed code email rather than failing loudly. Fail at the boundary.
    throw new Error(`Unknown verification purpose: ${String(purpose)}`);
  }
  const sections: EmailSection[] = [
    { kind: 'lead', text: copy.lead },
    { kind: 'code', code },
    { kind: 'note', text: copy.note },
  ];

  return {
    subject: copy.subject,
    html: emailLayout({
      // The code is intentionally not in the preheader: the inbox preview is
      // shown on a locked screen, and an OTP there is a small leak.
      preheader: copy.lead,
      headline: copy.headline,
      sections,
    }),
  };
}
