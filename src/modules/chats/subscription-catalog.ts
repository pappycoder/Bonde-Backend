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
} as const;

/** Checkout assistance only: no plan pricing, payment or activation authority. */
export function prepareSubscriptionCheckout(
  serviceId: string,
  countryCode: string,
  intent: string,
): ChatSubscriptionDto {
  if (!Object.hasOwn(subscriptionServices, serviceId))
    throw new BadRequestException('Choose Netflix or Spotify.');
  const country = countryCode.trim().toUpperCase();
  if (!isISO31661Alpha2(country))
    throw new BadRequestException('Ask for the account billing country.');
  if (!['NEW', 'RENEW'].includes(intent))
    throw new BadRequestException('Ask whether this is a new subscription or an existing account.');
  const key = serviceId as keyof typeof subscriptionServices;
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
    billingNote:
      'Choose or review your plan on the official service page. Confirm the current price, currency, billing period, renewal terms and payment eligibility there. Bonde has not charged you or confirmed activation. A reminder never authorizes payment.',
  };
}
