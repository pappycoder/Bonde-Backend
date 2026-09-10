import { codeBox } from './code-box.js';
import { emailLayout } from './layout.js';
import { lead, note } from './parts.js';
import type { EmailDoc } from './types.js';

export interface ForgotPasswordEmailInput {
  code: string;
}

/**
 * Password-reset code email, sent from the forgot-password flow. The reset
 * request stays fail-closed (the code is what authorizes the reset), so this
 * email is delivered through the same path as the sign-in codes.
 */
export function forgotPasswordEmail(input: ForgotPasswordEmailInput): EmailDoc {
  return {
    subject: 'Reset your Bonde password',
    html: emailLayout({
      preheader: 'Use this code to reset your Bonde password.',
      headline: 'Reset your password',
      body:
        lead(
          'We got a request to reset your Bonde password. Enter the code below to create a new one.',
        ) +
        codeBox(input.code) +
        note(
          'This code expires in 5 minutes. If you didn’t request a reset, you can safely ignore this email.',
        ),
    }),
  };
}
