import { emailLayout } from './layout.js';

export function cardAuthorizationEmail(code: string, last4: string) {
  return {
    subject: 'Your card payment verification code',
    html: emailLayout({
      headline: 'Verify your card payment',
      preheader: 'A verification code was requested for your Bonde card.',
      sections: [
        { kind: 'lead', text: `Use this code for the payment on your card ending in ${last4}.` },
        { kind: 'code', code },
        {
          kind: 'note',
          text: 'Only enter this code at the checkout you initiated. Never share it with anyone.',
        },
      ],
    }),
  };
}
