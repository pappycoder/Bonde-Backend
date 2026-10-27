/**
 * Outbound links and legal copy for the email footer.
 *
 * Links are centralised in one file: no template should ever fall back to
 * `href="#"`, because a dead anchor in a transactional email is a support
 * ticket waiting to happen.
 */
export const brandLinks = {
  /** TODO: confirm the registered legal entity name. */
  legalEntity: 'BONDE Technologies and Innovations Limited',
  copyrightYear: 2026,

  /** TODO: real support landing page (or a `mailto:` support address). */
  supportUrl: 'https://bonde.app/support',

  social: {
    linkedin: 'https://www.linkedin.com/company/usebonde/',
    x: 'https://x.com/usebonde?s=11',
    instagram: 'https://www.instagram.com/use_bonde?vrfl=dWs3cnZyOTM2M3hz&utm_source=qr',
  },
} as const;
