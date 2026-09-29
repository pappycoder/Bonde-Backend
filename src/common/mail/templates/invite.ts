import { emailLayout } from './layout.js';
import { lead, note, paragraph } from './parts.js';
import type { EmailDoc } from './types.js';

export interface InviteEmailInput {
  firstName: string;
  inviteUrl: string;
  role: string;
  expiresInDays: number;
}

/**
 * The single-use join link an admin issued. The link is the email proof (it only
 * reaches the invitee's inbox), so acceptance skips the OTP/verification dance
 * and lets them set their own password. Fail-closed: if this cannot be
 * delivered the invite is voided, because the token is never shown again.
 */
export function inviteEmail(input: InviteEmailInput): EmailDoc {
  const first = input.firstName.trim() || 'there';
  return {
    subject: 'You have been invited to Bonde',
    html: emailLayout({
      preheader: `Accept your ${input.role.toLowerCase().replace('_', ' ')} invitation to Bonde.`,
      headline: 'You are invited',
      eyebrow: 'Bonde team access',
      body:
        lead(
          `Hi ${first}, you have been invited to join Bonde as ${input.role.toLowerCase().replace('_', ' ')}.`,
        ) +
        paragraph(input.inviteUrl) +
        note(
          `This link can be used once and expires in ${input.expiresInDays} days. If you were not expecting this invitation, you can ignore this email.`,
        ),
    }),
  };
}
