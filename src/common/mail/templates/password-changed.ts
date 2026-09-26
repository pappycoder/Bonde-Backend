import { emailLayout } from './layout.js';
import { lead, note, paragraph } from './parts.js';
import type { EmailDoc } from './types.js';

export interface PasswordChangedEmailInput {
  firstName: string;
  revokedSessions: number;
}

/**
 * Confirmation emailed after a signed-in password change (the current password
 * was supplied, so this is a higher-trust event than the reset flow). States how
 * many other sessions were signed out. Best-effort: the change already happened,
 * so a delivery failure is logged, not fatal.
 */
export function passwordChangedEmail(input: PasswordChangedEmailInput): EmailDoc {
  const first = input.firstName.trim() || 'there';
  const revoked =
    input.revokedSessions > 0
      ? `We also signed out ${input.revokedSessions} other ${
          input.revokedSessions === 1 ? 'device' : 'devices'
        } that were signed in to your account.`
      : 'No other devices were signed in to your account.';
  return {
    subject: 'Your Bonde password was changed',
    html: emailLayout({
      preheader: 'Your Bonde password was successfully changed.',
      headline: 'Password updated',
      eyebrow: 'Security notice',
      body:
        lead(`Hi ${first}, your Bonde password was changed successfully.`) +
        paragraph(revoked) +
        note('If you didn’t make this change, contact Bonde support right away.'),
    }),
  };
}
