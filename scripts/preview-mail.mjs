#!/usr/bin/env node
// Run `pnpm build` first. Fictional data only; this never sends email.
import { mkdir, writeFile } from 'node:fs/promises';
import { verificationCodeEmail } from '../dist/common/mail/templates/verification-code.js';
import { welcomeEmail } from '../dist/common/mail/templates/welcome.js';
import { cardRegisteredEmail } from '../dist/common/mail/templates/card-registered.js';
import { passwordResetEmail } from '../dist/common/mail/templates/password-reset.js';
import { passwordChangedEmail } from '../dist/common/mail/templates/password-changed.js';
import { inviteEmail } from '../dist/common/mail/templates/invite.js';
import { waitlistConfirmationEmail } from '../dist/common/mail/templates/waitlist-confirmation.js';
import { waitlistSignupEmail } from '../dist/common/mail/templates/waitlist-signup.js';
import { contactMessageEmail } from '../dist/common/mail/templates/contact-message.js';

const docs = {
  verification: verificationCodeEmail('1234', 'verify-email'),
  recovery: verificationCodeEmail('1234', 'recovery'),
  welcome: welcomeEmail({ firstName: 'Amina', accountNumber: '1234567890' }),
  'card-registered': cardRegisteredEmail({
    firstName: 'Amina',
    last4: '4242',
    nickname: 'Groceries',
    maxSpendLimit: '2500.00',
    monthlyLimit: '50000.00',
    merchants: [],
  }),
  'password-reset': passwordResetEmail({ firstName: 'Amina' }),
  'password-changed': passwordChangedEmail({ firstName: 'Amina', revokedSessions: 1 }),
  invite: inviteEmail({
    firstName: 'Amina',
    inviteUrl: 'https://example.com/accept-invite?token=preview-only',
    role: 'ADMIN',
    expiresInDays: 7,
  }),
  'waitlist-confirmation': waitlistConfirmationEmail({
    email: 'preview@example.com',
    firstName: '{{firstName}}',
    alreadyJoined: false,
  }),
  'waitlist-signup': waitlistSignupEmail({
    email: 'amina@example.com',
    firstName: 'Amina',
    lastName: 'Sule',
    phone: '+2348012345678',
    source: 'Preview',
  }),
  contact: contactMessageEmail({
    name: 'Amina',
    email: 'amina@example.com',
    subject: 'Preview',
    message: 'A sample contact message.',
  }),
};
const dir = new URL('../docs/previews/emails/', import.meta.url);
await mkdir(dir, { recursive: true });
for (const [name, doc] of Object.entries(docs)) {
  await writeFile(new URL(`${name}.html`, dir), doc.html);
}
console.log(`Wrote ${Object.keys(docs).length} email previews to ${dir.pathname}`);
