import { emailLayout } from './layout.js';
import type { EmailSection } from './sections.js';
import type { EmailDoc } from './types.js';

export interface WaitlistSignupEmailInput {
  email: string;
  name: string | null;
  source: string | null;
}

/**
 * Internal notification sent to the Bonde inbox when someone joins the waitlist
 * from the public website. Best-effort: the signup is already persisted, so a
 * delivery failure never fails the request.
 *
 * The signup's values are passed through raw — the layout escapes them once.
 */
export function waitlistSignupEmail(input: WaitlistSignupEmailInput): EmailDoc {
  const sections: EmailSection[] = [
    {
      kind: 'lead',
      text: 'Someone new joined the Bonde waitlist from the website.',
    },
    {
      kind: 'facts',
      rows: [
        { label: 'Name', value: input.name },
        { label: 'Email', value: input.email },
        { label: 'Source', value: input.source },
      ],
    },
  ];

  return {
    subject: 'New waitlist signup',
    html: emailLayout({
      preheader: `New waitlist signup: ${input.email}.`,
      headline: 'New waitlist signup',
      eyebrow: 'Bonde website',
      sections,
    }),
  };
}
