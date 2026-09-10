import { describe, expect, it } from 'vitest';
import { esc } from './parts.js';
import { logoDataUri } from './assets/logo.js';
import { verificationCodeEmail } from './verification-code.js';
import { welcomeEmail } from './welcome.js';
import { forgotPasswordEmail } from './forgot-password.js';
import { cardRegisteredEmail } from './card-registered.js';
import { passwordResetEmail } from './password-reset.js';

describe('email templates', () => {
  it('embeds the transparent logo as a data URI (no external fetch)', () => {
    expect(logoDataUri).toMatch(/^data:image\/png;base64,/);
    expect(logoDataUri.length).toBeGreaterThan(100);
  });

  it('escapes dynamic values so they can never break the markup', () => {
    expect(esc(`<script>alert('x')</script>`)).toBe(
      '&lt;script&gt;alert(&#39;x&#39;)&lt;/script&gt;',
    );
  });

  it('renders a verification code email with five-minute expiry copy (fail-closed scope)', () => {
    const doc = verificationCodeEmail('1234', 'verify-email');
    expect(doc.subject).toBe('Your Bonde verification code');
    expect(doc.html).toContain('1234');
    expect(doc.html).toContain('expires in 5 minutes');
    expect(doc.html).toContain('data:image/png;base64,');
  });

  it('renders different subject lines per verification purpose', () => {
    expect(verificationCodeEmail('0000', 'recovery').subject).toBe('Your Bonde sign-in code');
    expect(verificationCodeEmail('0000', 'login').html).toContain('signing in');
  });

  it('renders a welcome email with the account number and no CTA buttons', () => {
    const doc = welcomeEmail({ firstName: 'Amina', accountNumber: '1234567890' });
    expect(doc.subject).toBe('Welcome to Bonde');
    expect(doc.html).toContain('Amina');
    expect(doc.html).toContain('Account number');
    expect(doc.html).toContain('1234567890');
    expect(doc.html).not.toContain('<a ');
  });

  it('falls back to a neutral greeting when the first name is missing', () => {
    const doc = welcomeEmail({ firstName: '   ', accountNumber: null });
    expect(doc.html).toContain('there');
    expect(doc.html).toContain('—');
  });

  it('renders a forgot-password email carrying the code', () => {
    const doc = forgotPasswordEmail({ code: '9876' });
    expect(doc.subject).toBe('Reset your Bonde password');
    expect(doc.html).toContain('9876');
    expect(doc.html).toContain('expires in 5 minutes');
  });

  it('renders a card-registered email with last4, nickname, limits and allowlist', () => {
    const doc = cardRegisteredEmail({
      firstName: 'Amina',
      last4: '4242',
      nickname: 'Groceries',
      maxSpendLimit: '2500.00',
      monthlyLimit: '50000.00',
      merchants: [{ merchantName: 'Acme Stores', merchantCode: 'M-ACME-001' }],
    });
    expect(doc.subject).toContain('4242');
    expect(doc.subject).toContain('ready');
    expect(doc.html).toContain('4242');
    expect(doc.html).toContain('Groceries');
    expect(doc.html).toContain('NGN 2500.00');
    expect(doc.html).toContain('NGN 50000.00');
    expect(doc.html).toContain('Acme Stores');
    expect(doc.html).toContain('M-ACME-001');
    expect(doc.html).not.toContain('<a ');
  });

  it('renders an empty allowlist as “None” on card registration', () => {
    const doc = cardRegisteredEmail({
      firstName: 'Amina',
      last4: '4242',
      nickname: null,
      maxSpendLimit: null,
      monthlyLimit: null,
      merchants: [],
    });
    expect(doc.html).toContain('None');
    expect(doc.html).toContain('—');
  });

  it('renders a password-reset confirmation email', () => {
    const doc = passwordResetEmail({ firstName: 'Amina' });
    expect(doc.subject).toBe('Your Bonde password was changed');
    expect(doc.html).toContain('was changed successfully');
    expect(doc.html).not.toContain('<a ');
  });

  it('never renders an unescaped code', () => {
    const doc = forgotPasswordEmail({ code: '<b>1234</b>' });
    expect(doc.html).not.toContain('<b>1234</b>');
  });
});
