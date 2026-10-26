import type { FinanceConfig } from '../modules/finance/finance.config.js';
/**
 * Typed view over validated environment configuration.
 *
 * Consume via `ConfigService<AppConfig, true>` so lookups are type-checked at
 * compile time. Values are normalized here (e.g. splitting CSV origins), so
 * feature modules never touch raw `process.env` directly.
 */
export interface AppConfig {
  finance: FinanceConfig;
  nodeEnv: string;
  profileHub: {
    billingEnabled: boolean;
    termsUrl: string | null;
    privacyUrl: string | null;
    subscriptionTermsUrl: string | null;
  };
  port: number;
  corsOrigins: string[];
  publicUrl: string;
  /** Base URL of the Next.js admin console (where invite links point). */
  adminAppUrl: string;
  /** Inbox that receives public website waitlist + contact notifications. */
  contactInboxEmail: string;
  supabase: {
    url: string;
    anonKey: string;
    serviceRoleKey: string;
  };
  auth: {
    tokenSecret: string;
  };
  database: {
    url: string;
    directUrl: string;
  };
  redis: {
    url: string;
  };
  throttle: {
    ttl: number;
    limit: number;
    blockDuration: number;
    strict: {
      ttl: number;
      limit: number;
      blockDuration: number;
    };
  };
  resend: {
    apiKey: string;
    fromEmail: string;
    logoUrl?: string;
    assetBaseUrl?: string;
  };
  termii: {
    apiKey: string;
    senderId: string;
  };
  push: {
    /// Path to the FCM service-account JSON. Empty/absent disables push
    /// delivery (dev-local apps still get in-app notifications).
    fcmServiceAccountPath?: string;
    /// Inline content of the FCM service-account JSON. Preferred on hosts
    /// with no persistent filesystem (e.g. Vercel serverless functions, which
    /// cannot read a service-account file). Takes precedence over the path.
    fcmServiceAccountJson?: string;
    /// Firebase project id used when initializing the FCM app (also present
    /// inside the service-account JSON).
    fcmProjectId?: string;
  };
  encryption: {
    cardKey: string;
    mfaKey: string;
  };
  kyc: {
    /// HMAC key used to digest BVN/NIN before storage (never the raw value).
    hashSecret: string;
  };
  passcode: {
    maxAttempts: number;
    lockMinutes: number;
  };
}

export default (): AppConfig => ({
  finance: {
    environment: process.env.FINANCE_ENVIRONMENT === 'production' ? 'production' : 'sandbox',
    enabled: process.env.FINANCE_ENABLED === 'true',
    ngnEnabled: process.env.FINANCE_NGN_ENABLED === 'true',
    usdEnabled: process.env.FINANCE_USD_ENABLED === 'true',
    feesVerified: process.env.FINANCE_FEES_VERIFIED === 'true',
    treasuryVerified: process.env.FINANCE_TREASURY_VERIFIED === 'true',
    sudoBaseUrl: process.env.SUDO_BASE_URL ?? 'https://api.sandbox.sudo.cards',
    sudoKey: process.env.SUDO_API_KEY ?? '',
    sudoBusinessId: process.env.SUDO_BUSINESS_ID ?? '',
    sudoWebhookToken: process.env.SUDO_WEBHOOK_TOKEN ?? '',
    safeHavenBaseUrl: process.env.SAFE_HAVEN_BASE_URL ?? 'https://api.sandbox.safehavenmfb.com',
    safeHavenClientId: process.env.SAFE_HAVEN_CLIENT_ID ?? '',
    safeHavenIssuer: process.env.SAFE_HAVEN_ISSUER ?? '',
    safeHavenPrivateKey: process.env.SAFE_HAVEN_PRIVATE_KEY ?? '',
    safeHavenWebhookToken: process.env.SAFE_HAVEN_WEBHOOK_TOKEN ?? '',
    safeHavenBankCode: process.env.SAFE_HAVEN_BANK_CODE ?? '',
    treasuryAccountNumber: process.env.FINANCE_TREASURY_ACCOUNT_NUMBER ?? '',
    ngnFundingSourceId: process.env.SUDO_NGN_FUNDING_SOURCE_ID ?? '',
    usdFundingSourceId: process.env.SUDO_USD_FUNDING_SOURCE_ID ?? '',
    ngnSettlementId: process.env.SUDO_NGN_SETTLEMENT_ID ?? '',
    usdSettlementId: process.env.SUDO_USD_SETTLEMENT_ID ?? '',
    ngnBrand: process.env.SUDO_NGN_BRAND ?? 'Verve',
    usdBrand: process.env.SUDO_USD_BRAND ?? 'MasterCard',
    ngnIssueFee: process.env.SUDO_NGN_ISSUE_FEE ?? '0.00',
    usdIssueFee: process.env.SUDO_USD_ISSUE_FEE ?? '0.00',
    withdrawalFee: process.env.SAFE_HAVEN_WITHDRAWAL_FEE ?? '0.00',
    incomingFeeBearer:
      process.env.SAFE_HAVEN_INCOMING_FEE_BEARER === 'sender'
        ? 'sender'
        : process.env.SAFE_HAVEN_INCOMING_FEE_BEARER === 'recipient'
          ? 'recipient'
          : 'unknown',
    jobToken: process.env.FINANCE_JOB_TOKEN ?? '',
  },
  nodeEnv: process.env.NODE_ENV ?? 'development',
  profileHub: {
    billingEnabled: (process.env.PROFILE_BILLING_ENABLED ?? 'true').toLowerCase() === 'true',
    termsUrl: process.env.TERMS_URL || 'https://www.usebonde.com',
    privacyUrl: process.env.PRIVACY_URL || 'https://www.usebonde.com',
    subscriptionTermsUrl: process.env.SUBSCRIPTION_TERMS_URL || 'https://www.usebonde.com',
  },
  port: Number(process.env.PORT ?? 3001),
  corsOrigins: (process.env.CORS_ORIGINS ?? '')
    .split(',')
    .map((origin) => origin.trim())
    .filter(Boolean),
  publicUrl: process.env.PUBLIC_URL ?? 'http://localhost:3001',
  adminAppUrl: process.env.ADMIN_APP_URL ?? 'http://localhost:3000',
  contactInboxEmail: process.env.CONTACT_INBOX_EMAIL ?? 'usebonde@gmail.com',
  supabase: {
    url: process.env.SUPABASE_URL!,
    anonKey: process.env.SUPABASE_ANON_KEY!,
    serviceRoleKey: process.env.SUPABASE_SERVICE_ROLE_KEY!,
  },
  auth: {
    tokenSecret: process.env.AUTH_TOKEN_SECRET!,
  },
  database: {
    url: process.env.DATABASE_URL!,
    directUrl: process.env.DIRECT_URL!,
  },
  redis: {
    url: process.env.REDIS_URL ?? 'redis://localhost:6379',
  },
  throttle: {
    ttl: Number(process.env.THROTTLE_TTL ?? 60_000),
    limit: Number(process.env.THROTTLE_LIMIT ?? 100),
    blockDuration: Number(process.env.THROTTLE_BLOCK_DURATION ?? 0),
    strict: {
      ttl: Number(process.env.THROTTLE_STRICT_TTL ?? 60_000),
      limit: Number(process.env.THROTTLE_STRICT_LIMIT ?? 5),
      blockDuration: Number(process.env.THROTTLE_STRICT_BLOCK_DURATION ?? 300_000),
    },
  },
  resend: {
    apiKey: process.env.RESEND_API_KEY!,
    fromEmail: process.env.RESEND_FROM_EMAIL ?? 'noreply@bonde.app',
    logoUrl: process.env.MAIL_LOGO_URL,
    assetBaseUrl: process.env.MAIL_ASSET_BASE_URL,
  },
  termii: {
    apiKey: process.env.TERMII_API_KEY!,
    senderId: process.env.TERMII_SENDER_ID ?? 'Bonde',
  },
  encryption: {
    cardKey: process.env.CARD_ENCRYPTION_KEY!,
    // Separate key for authenticator secrets; falls back to the app-wide key so
    // existing deployments keep working until MFA_ENCRYPTION_KEY is set.
    mfaKey: process.env.MFA_ENCRYPTION_KEY ?? process.env.CARD_ENCRYPTION_KEY!,
  },
  kyc: {
    // Pepper for the one-way identifiers. Falls back to the app-wide encryption
    // key so existing deployments keep booting until KYC_HASH_SECRET is set.
    hashSecret: process.env.KYC_HASH_SECRET ?? process.env.CARD_ENCRYPTION_KEY!,
  },
  push: {
    fcmServiceAccountPath: process.env.FIREBASE_SERVICE_ACCOUNT_PATH,
    fcmServiceAccountJson: process.env.FIREBASE_SERVICE_ACCOUNT_JSON,
    fcmProjectId: process.env.FIREBASE_PROJECT_ID,
  },
  passcode: {
    maxAttempts: Number(process.env.PASSCODE_MAX_ATTEMPTS ?? 5),
    lockMinutes: Number(process.env.PASSCODE_LOCK_MINUTES ?? 15),
  },
});
