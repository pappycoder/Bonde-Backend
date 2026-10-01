import { emailLayout } from './layout.js';
import type { EmailSection } from './sections.js';
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
  const sections: EmailSection[] = [
    { kind: 'lead', text: `Hi ${first}, your Bonde password was changed successfully.` },
    {
      kind: 'paragraph',
      text: 'If this was you, you’re all set — no further action is needed.',
    },
    {
      kind: 'note',
      text: 'If you didn’t make this change, contact Bonde support right away.',
    },
  ];

  return {
    subject: 'Your Bonde password was changed',
    html: emailLayout({
      preheader: 'Your Bonde password was successfully changed.',
      headline: 'Password updated',
      eyebrow: 'Security notice',
      sections,
    }),
  };
}
