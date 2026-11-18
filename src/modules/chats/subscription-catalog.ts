import { BadRequestException } from '@nestjs/common';
import { isISO31661Alpha2 } from 'class-validator';
import { randomUUID } from 'node:crypto';
import type { ChatSubscriptionDto } from './chat-replies.dto.js';

export const subscriptionServices = {
  netflix: {
    name: 'Netflix',
    signup: 'https://www.netflix.com/signup',
    account: 'https://www.netflix.com/YourAccount',
    sourceUrl: 'https://help.netflix.com/en/node/116380',
  },
  spotify: {
    name: 'Spotify Premium',
    signup: 'https://www.spotify.com/premium/',
    account: 'https://www.spotify.com/account/',
    sourceUrl: 'https://support.spotify.com/article/payment-methods/',
  },
  'youtube-premium': {
    name: 'YouTube Premium',
    signup: 'https://www.youtube.com/premium',
    account: 'https://www.youtube.com/paid_memberships',
    sourceUrl: 'https://support.google.com/youtube/answer/10217125',
  },
  'apple-music': {
    name: 'Apple Music',
    signup: 'https://music.apple.com/',
    account: 'https://music.apple.com/',
    sourceUrl: 'https://support.apple.com/118399',
  },
  'prime-video': {
    name: 'Prime Video',
    signup: 'https://www.primevideo.com/',
    account: 'https://www.primevideo.com/settings',
    sourceUrl: 'https://www.primevideo.com/help?nodeId=GWGDSNXVPJ93UW5V',
  },
  'google-one': {
    name: 'Google One',
    signup: 'https://one.google.com/about/plans',
    account: 'https://one.google.com/settings',
    sourceUrl: 'https://support.google.com/googleone/answer/9056360',
  },
  'microsoft-365': {
    name: 'Microsoft 365',
    signup: 'https://www.microsoft.com/microsoft-365',
    account: 'https://account.microsoft.com/services',
    sourceUrl:
      'https://support.microsoft.com/en-us/accounts-billing/subscriptions/change-your-microsoft-subscription-payment-method-and-options',
  },
  'canva-pro': {
    name: 'Canva Pro',
    signup: 'https://www.canva.com/pricing/',
    account: 'https://www.canva.com/',
    sourceUrl: 'https://www.canva.com/help/billing-plan-management/',
  },
  'adobe-creative-cloud': {
    name: 'Adobe Creative Cloud',
    signup: 'https://www.adobe.com/creativecloud/plans.html',
    account: 'https://account.adobe.com/plans',
    sourceUrl:
      'https://helpx.adobe.com/account/individual/subscriptions-and-plans/plan-changes-and-upgrades/change-adobe-plan.html',
  },
} as const;

export type SubscriptionServiceId = keyof typeof subscriptionServices;
export const subscriptionServiceIds = Object.keys(subscriptionServices) as SubscriptionServiceId[];
export const subscriptionCheckoutUrls = [
  ...new Set(Object.values(subscriptionServices).flatMap((s) => [s.signup, s.account])),
];
export const subscriptionSourceUrls = Object.values(subscriptionServices).map((s) => s.sourceUrl);

export const subscriptionHandoffNotes: Record<SubscriptionServiceId, string> = {
  netflix: '',
  spotify: '',
  'youtube-premium':
    'Google sign-in may be unavailable in an embedded browser. Memberships billed through Apple or Google Play may need to be managed with the original billing provider.',
  'apple-music':
    'On Apple Music, sign in and open Account → Settings → Subscriptions. Some account changes require the original billing provider or device settings.',
  'prime-video':
    'Review Account & Settings for an existing subscription. Amazon Prime bundles and third-party billing may need to be managed with the original billing provider.',
  'google-one':
    'Google sign-in may be unavailable in an embedded browser. Existing App Store subscriptions may need to be managed with the original billing provider.',
  'microsoft-365':
    'Sign in with the Microsoft account that owns the subscription. Business, school and third-party subscriptions may need to be managed by the original billing provider or organization administrator.',
  'canva-pro':
    'For an existing account, sign in to Canva and open Settings → Billing. Team or third-party subscriptions may need to be managed by the team owner or original billing provider.',
  'adobe-creative-cloud':
    'Review the plan commitment, billing frequency and cancellation terms before confirming. Team and third-party subscriptions may need to be managed by the original billing provider or organization administrator.',
};

/** Checkout assistance only: no plan pricing, payment or activation authority. */
export function prepareSubscriptionCheckout(
  serviceId: string,
  countryCode: string,
  intent: string,
): ChatSubscriptionDto {
  if (!Object.hasOwn(subscriptionServices, serviceId))
    throw new BadRequestException(
      `Choose a supported service: ${Object.values(subscriptionServices)
        .map((s) => s.name)
        .join(', ')}.`,
    );
  const country = countryCode.trim().toUpperCase();
  if (!isISO31661Alpha2(country))
    throw new BadRequestException('Ask for the account billing country.');
  if (!['NEW', 'RENEW'].includes(intent))
    throw new BadRequestException('Ask whether this is a new subscription or an existing account.');
  const key = serviceId as SubscriptionServiceId;
  const service = subscriptionServices[key];
  return {
    id: randomUUID(),
    serviceId: key,
    name: service.name,
    countryCode: country,
    intent: intent as 'NEW' | 'RENEW',
    checkoutUrl: intent === 'NEW' ? service.signup : service.account,
    sourceUrl: service.sourceUrl,
    priceStatus: 'CHECK_AT_CHECKOUT',
    activationStatus: 'UNVERIFIED',
    billingNote: [
      'Choose or review your plan on the official service page. Confirm the current price, currency, billing period, renewal terms and payment eligibility there. Bonde has not charged you or confirmed activation. A reminder never authorizes payment.',
      subscriptionHandoffNotes[key],
    ]
      .filter(Boolean)
      .join(' '),
  };
}
