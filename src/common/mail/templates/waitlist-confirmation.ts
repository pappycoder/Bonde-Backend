import { emailLayout } from './layout.js';
import type { EmailDoc } from './types.js';

/** Confirmation for both a new signup and a request to an existing signup. */
export function waitlistConfirmationEmail(input: {
  email: string;
  firstName: string | null;
  alreadyJoined: boolean;
}): EmailDoc {
  const firstName = input.firstName?.trim();
  return {
    subject: input.alreadyJoined
      ? 'You’re already on the Bonde waitlist'
      : "You're on the list. Welcome to BONDE!🚀",
    html: emailLayout({
      preheader: 'Thank you for joining the waitlist! The AI does the work. You stay in control.',
      headline: "You're on the list. Welcome to BONDE!🚀",
      variant: 'waitlist',
      sections: [
        { kind: 'paragraph', text: firstName ? `Hello ${firstName},` : 'Hello,' },
        { kind: 'paragraph', text: 'Thank you for joining the waitlist!' },
        {
          kind: 'paragraph',
          text: 'We’re building a smarter way to get things done online. Soon, you’ll be able to delegate purchases and supported financial tasks to AI, with spending controls that help you stay in charge.',
        },
        {
          kind: 'paragraph',
          text: 'We’re still building, and you’ll be among the first to hear when BONDE is ready for early access.',
        },
        {
          kind: 'paragraph',
          text: 'In the meantime, stay tuned. We’re just getting started!',
        },
        { kind: 'paragraph', text: 'The AI does the work. You stay in control.' },
        { kind: 'paragraph', text: 'The BONDE Team', bold: true },
      ],
    }),
  };
}
