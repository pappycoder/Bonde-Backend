import { describe, expect, it } from 'vitest';
import { esc } from './parts.js';
import { mailAssets } from './assets/index.js';
import { logoDataUri } from './assets/logo.js';
import { brandLinks } from './links.js';
import { verificationCodeEmail, type VerificationPurpose } from './verification-code.js';
import { welcomeEmail } from './welcome.js';
import { cardRegisteredEmail } from './card-registered.js';
import { passwordResetEmail } from './password-reset.js';
import { passwordChangedEmail } from './password-changed.js';
import { inviteEmail } from './invite.js';

/** Every anchor the shared footer contributes: 3 social icons + 1 support link. */
const FOOTER_ANCHORS = 4;

/** Anchors a template adds beyond the shared footer. Invite's link is the email. */
const EXTRA_ANCHORS: Record<string, number> = { invite: 1 };

/** All templates, so the shared-layout guarantees are asserted uniformly. */
function allDocs() {
  return {
    'verification-code': verificationCodeEmail('1234', 'verify-email'),
    welcome: welcomeEmail({ firstName: 'Amina', accountNumber: '1234567890' }),
    'card-registered': cardRegisteredEmail({
      firstName: 'Amina',
      last4: '4242',
      nickname: 'Groceries',
      maxSpendLimit: '2500.00',
      monthlyLimit: '50000.00',
      merchants: [{ merchantName: 'Acme Stores', merchantCode: 'M-ACME-001' }],
    }),
    'password-reset': passwordResetEmail({ firstName: 'Amina' }),
    'password-changed': passwordChangedEmail({ firstName: 'Amina', revokedSessions: 1 }),
    invite: inviteEmail({
      firstName: 'Amina',
      inviteUrl: 'https://app.bonde.app/invite/abc123',
      role: 'MERCHANT_ADMIN',
      expiresInDays: 7,
    }),
  };
}

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

  it('registers every footer asset with a hosted filename', () => {
    expect(Object.keys(mailAssets)).toEqual([
      'logo',
      'socialLinkedIn',
      'socialX',
      'socialInstagram',
    ]);
    for (const asset of Object.values(mailAssets)) {
      expect(asset.file).toMatch(/\.png$/);
      expect(asset.dataUri).toMatch(/^data:image\/png;base64,/);
      expect(asset.alt.length).toBeGreaterThan(0);
    }
  });

  describe('shared layout', () => {
    it.each(Object.entries(allDocs()))(
      '%s carries the dark-mode hardening the clients need',
      (_name, doc) => {
        // Gmail ignores prefers-color-scheme, so light colours must be inline…
        expect(doc.html).toContain('background-color:#FFFFFF');
        // …and the media query plus Outlook.com's attribute selectors cover the rest.
        expect(doc.html).toContain('@media (prefers-color-scheme: dark)');
        expect(doc.html).toContain('[data-ogsc]');
        expect(doc.html).toContain('name="color-scheme" content="light dark"');
        expect(doc.html).toContain('supported-color-schemes');
      },
    );

    it.each(Object.entries(allDocs()))(
      '%s repeats the header background-color before the gradient for Outlook',
      (_name, doc) => {
        // Outlook's Word engine drops the `background` shorthand entirely.
        expect(doc.html).toContain(
          'padding:40px 24px;background-color:#0B0B0C;background-image:linear-gradient',
        );
      },
    );

    it.each(Object.entries(allDocs()))(
      '%s wraps long tokens instead of overflowing',
      (_name, doc) => {
        // Codes, account numbers and join URLs must not force a horizontal scroll
        // on a 360px client. Inherited from <body>, so one rule covers every
        // renderer without each one opting in.
        expect(doc.html).toContain('word-break:break-word');
        expect(doc.html).toContain('overflow-wrap:break-word');
      },
    );

    it.each(Object.entries(allDocs()))(
      '%s contains only expected anchors — no CTA buttons',
      (name, doc) => {
        const anchors = doc.html.match(/<a\s/g) ?? [];
        expect(anchors).toHaveLength(FOOTER_ANCHORS + (EXTRA_ANCHORS[name] ?? 0));
        expect(doc.html).not.toContain('mailto:');
      },
    );

    it.each(Object.entries(allDocs()))('%s renders the branded footer', (_name, doc) => {
      expect(doc.html).toContain(`&copy; ${brandLinks.copyrightYear} ${brandLinks.legalEntity}`);
      expect(doc.html).toContain(brandLinks.supportUrl);
      for (const url of Object.values(brandLinks.social)) {
        expect(doc.html).toContain(url);
      }
      // No dead anchors.
      expect(doc.html).not.toContain('href="#"');
    });
  });

  describe('verification codes', () => {
    it('renders a code with five-minute expiry copy (fail-closed scope)', () => {
      const doc = verificationCodeEmail('1234', 'verify-email');
      expect(doc.subject).toBe('Verify your email');
      expect(doc.html).toContain('1234');
      expect(doc.html).toContain('expires in 5 minutes');
      expect(doc.html).toContain('data:image/png;base64,');
    });

    it('gives each reachable purpose a distinct subject and body', () => {
      const purposes: VerificationPurpose[] = ['verify-email', 'recovery'];
      const subjects = purposes.map((p) => verificationCodeEmail('0000', p).subject);
      expect(new Set(subjects).size).toBe(subjects.length);

      expect(verificationCodeEmail('0000', 'verify-email').subject).toBe('Verify your email');
      expect(verificationCodeEmail('0000', 'recovery').subject).toBe('Reset your Bonde password');
      expect(verificationCodeEmail('0000', 'recovery').html).toContain('reset your Bonde password');
    });

    it('rejects a purpose it has no copy for, rather than shipping a mislabeled code', () => {
      // Login is password-only and 2FA is TOTP, so neither reaches this template.
      // A future caller passing an unlisted flow must fail at the boundary —
      // this email carries a credential and its subject must be trustworthy.
      const call = verificationCodeEmail as unknown as (
        c: string,
        p: string,
      ) => { subject: string };
      expect(() => call('0000', 'login')).toThrow(/Unknown verification purpose: login/);
    });

    it('keeps the code out of the preheader so it cannot leak on a lock screen', () => {
      const html = verificationCodeEmail('987654', 'recovery').html;
      const preheader = html.match(/max-height:0[^>]*>([^<]+)</)?.[1];
      expect(preheader).toBeDefined();
      expect(preheader).not.toContain('987654');
    });

    it('never renders an unescaped code', () => {
      const doc = verificationCodeEmail('<b>1234</b>', 'recovery');
      expect(doc.html).not.toContain('<b>1234</b>');
      expect(doc.html).toContain('&lt;b&gt;1234&lt;/b&gt;');
    });
  });

  describe('welcome', () => {
    it('renders the account number and next steps', () => {
      const doc = welcomeEmail({ firstName: 'Amina', accountNumber: '1234567890' });
      expect(doc.subject).toBe('Welcome to Bonde');
      expect(doc.html).toContain('Amina');
      expect(doc.html).toContain('Account number');
      expect(doc.html).toContain('1234567890');
      expect(doc.html).toContain('What you can do now');
    });

    it('falls back to a neutral greeting and an em dash when data is missing', () => {
      const doc = welcomeEmail({ firstName: '   ', accountNumber: null });
      expect(doc.html).toContain('there');
      expect(doc.html).toContain('—');
    });

    it('escapes the first name exactly once', () => {
      // The layout escapes the headline; renderers must not pre-escape.
      const doc = welcomeEmail({ firstName: 'Ben & Jerry', accountNumber: null });
      expect(doc.html).toContain('Welcome to Bonde, Ben &amp; Jerry');
      expect(doc.html).not.toContain('&amp;amp;');
    });
  });

  describe('card registration', () => {
    it('renders last4, nickname, limits and the merchant allowlist', () => {
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
    });

    it('renders an empty allowlist as “None”', () => {
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
  });

  describe('password changes', () => {
    it('renders the reset confirmation', () => {
      const doc = passwordResetEmail({ firstName: 'Amina' });
      expect(doc.subject).toBe('Your Bonde password was changed');
      expect(doc.html).toContain('was changed successfully');
    });

    it('reports the number of other devices signed out', () => {
      expect(passwordChangedEmail({ firstName: 'Amina', revokedSessions: 1 }).html).toContain(
        'signed out 1 other device',
      );
      expect(passwordChangedEmail({ firstName: 'Amina', revokedSessions: 3 }).html).toContain(
        'signed out 3 other devices',
      );
      expect(passwordChangedEmail({ firstName: 'Amina', revokedSessions: 0 }).html).toContain(
        'No other devices were signed in',
      );
    });
  });

  describe('invites', () => {
    it('carries the single-use join link as a real anchor', () => {
      const url = 'https://app.bonde.app/invite/abc123';
      const doc = inviteEmail({
        firstName: 'Amina',
        inviteUrl: url,
        role: 'MERCHANT_ADMIN',
        expiresInDays: 7,
      });
      expect(doc.subject).toBe('You have been invited to Bonde');
      // Must be clickable: this token is shown exactly once, in this email.
      expect(doc.html).toMatch(/<a[^>]+href="https:\/\/app\.bonde\.app\/invite\/abc123"/);
      // And must not overflow the card on a narrow client.
      expect(doc.html).toContain('word-break:break-all');
      expect(doc.html).toContain('expires in 7 days');
      expect(doc.html).toContain('merchant admin');
    });

    it('escapes a hostile invite URL rather than injecting markup', () => {
      const doc = inviteEmail({
        firstName: 'Amina',
        inviteUrl: 'https://x.app/i?a=1&b="><script>alert(1)</script>',
        role: 'MERCHANT_ADMIN',
        expiresInDays: 7,
      });
      expect(doc.html).not.toContain('<script>');
      expect(doc.html).toContain('&lt;script&gt;');
    });
  });
});
