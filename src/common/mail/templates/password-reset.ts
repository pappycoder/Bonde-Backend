import { emailLayout } from './layout.js';
import { lead, note, paragraph } from './parts.js';
import type { EmailDoc } from './types.js';

export interface PasswordResetEmailInput {
  firstName: string;
}

/**
 * Confirmation emailed after a successful password reset. Best-effort: the
 * reset already happened; a delivery failure is logged, not fatal.
 */
export function passwordResetEmail(input: PasswordResetEmailInput): EmailDoc {
  const first = input.firstName.trim() || 'there';
  return {
    subject: 'Your Bonde password was changed',
    html: emailLayout({
      preheader: 'Your Bonde password was successfully changed.',
      headline: 'Password updated',
      eyebrow: 'Security notice',
      body:
        lead(`Hi ${first}, your Bonde password was changed successfully.`) +
        paragraph('If this was you, you’re all set — no further action is needed.') +
        note('If you didn’t make this change, contact Bonde support right away.'),
    }),
  };
}
