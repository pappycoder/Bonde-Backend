import { logoDataUri } from './logo.js';
import { socialDataUris } from './social.js';

/**
 * Asset registry for transactional emails. All images shipped in the HTML are
 * referenced by these keys, so we can rewrite their `src` values wholesale to
 * a hosted base URL without touching every template.
 *
 * `dataUri` values are fallbacks that work in development and anywhere an
 * external request is undesirable. In production you should typically set
 * `MAIL_ASSET_BASE_URL` (and optionally `MAIL_LOGO_URL`) so Gmail/Outlook stop
 * stripping `data:` images.
 */
export const mailAssets = {
  logo: {
    file: 'logo.png',
    alt: 'Bonde',
    dataUri: logoDataUri,
  },
  socialLinkedIn: {
    file: 'linkedin.png',
    alt: 'Bonde on LinkedIn',
    dataUri: socialDataUris.linkedin,
  },
  socialX: {
    file: 'x.png',
    alt: 'Bonde on X',
    dataUri: socialDataUris.x,
  },
  socialInstagram: {
    file: 'instagram.png',
    alt: 'Bonde on Instagram',
    dataUri: socialDataUris.instagram,
  },
} as const;

export type MailAssetKey = keyof typeof mailAssets;
export type MailAsset = (typeof mailAssets)[MailAssetKey];
