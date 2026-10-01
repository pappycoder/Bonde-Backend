/**
 * Outbound links and legal copy for the email footer.
 *
 * Everything here is a placeholder until the real destinations exist. They are
 * centralised in one file on purpose: no template should ever fall back to
 * `href="#"`, because a dead anchor in a transactional email is a support
 * ticket waiting to happen.
 *
 * TODO: replace every `TODO` below with the real destination.
 */
export const brandLinks = {
  /** TODO: confirm the registered legal entity name. */
  legalEntity: 'BONDE Technologies and Innovations Limited',
  copyrightYear: 2026,

  /** TODO: real support landing page (or a `mailto:` support address). */
  supportUrl: 'https://bonde.app/support',

  social: {
    /** TODO: real LinkedIn company page. */
    linkedin: 'https://www.linkedin.com/company/usebonde',
    /** TODO: real X profile. */
    x: 'https://x.com/usebonde',
    /** TODO: real Instagram profile. */
    instagram: 'https://www.instagram.com/usebonde',
  },
} as const;
