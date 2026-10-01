import { emailLayout } from './layout.js';
import type { EmailSection } from './sections.js';
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
  const role = input.role.toLowerCase().replace('_', ' ');

  const sections: EmailSection[] = [
    { kind: 'lead', text: `Hi ${first}, you have been invited to join Bonde as ${role}.` },
    // The link is the whole point of this email and is single-use, so it has to
    // be a real anchor. A stale/mangled URL is a support ticket: the token is
    // only ever shown here.
    { kind: 'link', text: 'Accept your invitation', url: input.inviteUrl },
    {
      kind: 'note',
      text: `This link can be used once and expires in ${input.expiresInDays} days. If you were not expecting this invitation, you can ignore this email.`,
    },
  ];

  return {
    subject: 'You have been invited to Bonde',
    html: emailLayout({
      preheader: `Accept your ${role} invitation to Bonde.`,
      headline: 'You are invited',
      eyebrow: 'Bonde team access',
      sections,
    }),
  };
}
