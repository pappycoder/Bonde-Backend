import { logoDataUri } from './logo.js';
import { socialDataUris } from './social.js';

/** Existing public, unsigned PNG folder used by the deployed emails. */
export const DEFAULT_MAIL_ASSET_BASE_URL =
  'https://emnfjlqdgnavrshpqqis.supabase.co/storage/v1/object/public/logo';

/** Source artifacts remain available for regeneration, never embedded in email HTML. */
export const mailAssets = {
  logo: {
    file: 'logo.png',
    src: `${DEFAULT_MAIL_ASSET_BASE_URL}/logo.png`,
    alt: 'Bonde',
    dataUri: logoDataUri,
  },
  socialLinkedIn: {
    file: 'linkedin.png',
    src: `${DEFAULT_MAIL_ASSET_BASE_URL}/linkedin.png`,
    alt: 'Bonde on LinkedIn',
    dataUri: socialDataUris.linkedin,
  },
  socialX: {
    file: 'x.png',
    src: `${DEFAULT_MAIL_ASSET_BASE_URL}/x.png`,
    alt: 'Bonde on X',
    dataUri: socialDataUris.x,
  },
  socialInstagram: {
    file: 'instagram.png',
    src: `${DEFAULT_MAIL_ASSET_BASE_URL}/instagram.png`,
    alt: 'Bonde on Instagram',
    dataUri: socialDataUris.instagram,
  },
} as const;

export type MailAssetKey = keyof typeof mailAssets;
export type MailAsset = (typeof mailAssets)[MailAssetKey];
