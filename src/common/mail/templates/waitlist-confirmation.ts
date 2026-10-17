import { emailLayout } from './layout.js';
import type { EmailDoc } from './types.js';

/** Confirmation for both a new signup and a request to an existing signup. */
export function waitlistConfirmationEmail(input: {
  email: string;
  name: string | null;
  alreadyJoined: boolean;
}): EmailDoc {
  const greeting = input.name?.trim() ? `Hi ${input.name.trim()},` : 'Hello,';
  return {
    subject: input.alreadyJoined
      ? 'You’re already on the Bonde waitlist'
      : 'You’re on the Bonde waitlist',
    html: emailLayout({
      preheader:
        'Your place on the Bonde waitlist is confirmed. We’ll let you know when early access opens.',
      headline: input.alreadyJoined ? 'Your place is already saved' : 'Welcome to the waitlist',
      eyebrow: 'Bonde early access',
      sections: [
        { kind: 'paragraph', text: greeting },
        {
          kind: 'lead',
          text: input.alreadyJoined
            ? 'You’re already on the Bonde waitlist. Your place is confirmed, and there’s nothing else you need to do.'
            : 'Thanks for joining the Bonde waitlist. Your place is confirmed, and we’re glad to have you here.',
        },
        { kind: 'facts', rows: [{ label: 'Waitlist email', value: input.email }] },
        { kind: 'paragraph', text: 'What happens next' },
        {
          kind: 'bullets',
          items: [
            'We’ll email you when early access becomes available.',
            'You’ll receive the next steps for getting started with Bonde.',
            'You don’t need to sign up again — we’ve saved your email address.',
          ],
        },
        {
          kind: 'note',
          text: 'If you didn’t request this email, you can safely ignore it. Joining the waitlist does not create a Bonde wallet or account.',
        },
        { kind: 'paragraph', text: 'Thanks for being part of the journey.\nThe Bonde team' },
      ],
    }),
  };
}
