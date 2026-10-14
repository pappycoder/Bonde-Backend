import { emailLayout } from './layout.js';
import type { EmailSection } from './sections.js';
import type { EmailDoc } from './types.js';

export interface ContactMessageEmailInput {
  name: string;
  email: string;
  subject: string | null;
  message: string;
}

/**
 * Internal notification sent to the Bonde inbox when someone submits the public
 * contact form. Best-effort: the message is already persisted, so a delivery
 * failure never fails the request.
 *
 * The sender's values are passed through raw — the layout escapes them once.
 */
export function contactMessageEmail(input: ContactMessageEmailInput): EmailDoc {
  const sections: EmailSection[] = [
    {
      kind: 'lead',
      text: 'A new message was submitted through the Bonde website contact form.',
    },
    {
      kind: 'facts',
      rows: [
        { label: 'Name', value: input.name },
        { label: 'Email', value: input.email },
        { label: 'Subject', value: input.subject },
      ],
    },
    { kind: 'paragraph', text: input.message },
  ];

  return {
    subject: `Website contact — ${input.subject?.trim() || input.name}`,
    html: emailLayout({
      preheader: `New contact message from ${input.name}.`,
      headline: 'New contact message',
      eyebrow: 'Bonde website',
      sections,
    }),
  };
}
