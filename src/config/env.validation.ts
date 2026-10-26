import Joi from 'joi';

/**
 * Joi validation schema for environment variables.
 *
 * The application fails fast at boot if required variables are missing or
 * malformed, so misconfiguration never silently reaches a request handler.
 */
export const envValidationSchema = Joi.object({
  FINANCE_ENVIRONMENT: Joi.string().valid('sandbox', 'production').default('sandbox'),
  FINANCE_ENABLED: Joi.boolean().default(false),
  FINANCE_NGN_ENABLED: Joi.boolean().default(false),
  FINANCE_USD_ENABLED: Joi.boolean().default(false),
  FINANCE_FEES_VERIFIED: Joi.boolean().default(false),
  FINANCE_TREASURY_VERIFIED: Joi.boolean().default(false),
  SUDO_BASE_URL: Joi.string()
    .uri({ scheme: ['https'] })
    .default('https://api.sandbox.sudo.cards'),
  SUDO_API_KEY: Joi.string().allow('').default(''),
  SUDO_BUSINESS_ID: Joi.string().allow('').default(''),
  SUDO_WEBHOOK_TOKEN: Joi.string().allow('').default(''),
  SAFE_HAVEN_BASE_URL: Joi.string()
    .uri({ scheme: ['https'] })
    .default('https://api.sandbox.safehavenmfb.com'),
  SAFE_HAVEN_ISSUER: Joi.string()
    .uri({ scheme: ['https'] })
    .allow('')
    .default(''),
  SAFE_HAVEN_CLIENT_ID: Joi.string().allow('').default(''),
  SAFE_HAVEN_PRIVATE_KEY: Joi.string().allow('').default(''),
  SAFE_HAVEN_WEBHOOK_TOKEN: Joi.string().allow('').default(''),
  SAFE_HAVEN_BANK_CODE: Joi.string().allow('').default(''),
  FINANCE_TREASURY_ACCOUNT_NUMBER: Joi.string().allow('').default(''),
  SUDO_NGN_FUNDING_SOURCE_ID: Joi.string().allow('').default(''),
  SUDO_USD_FUNDING_SOURCE_ID: Joi.string().allow('').default(''),
  SUDO_NGN_SETTLEMENT_ID: Joi.string().allow('').default(''),
  SUDO_USD_SETTLEMENT_ID: Joi.string().allow('').default(''),
  SUDO_NGN_BRAND: Joi.string().allow('').default('Verve'),
  SUDO_USD_BRAND: Joi.string().allow('').default('MasterCard'),
  SUDO_NGN_ISSUE_FEE: Joi.string().allow('').default('0.00'),
  SUDO_USD_ISSUE_FEE: Joi.string().allow('').default('0.00'),
  SAFE_HAVEN_INCOMING_FEE_BEARER: Joi.string()
    .valid('unknown', 'sender', 'recipient')
    .default('unknown'),
  SAFE_HAVEN_WITHDRAWAL_FEE: Joi.string().allow('').default('0.00'),
  FINANCE_JOB_TOKEN: Joi.string().allow('').default(''),
  NODE_ENV: Joi.string().valid('development', 'production', 'test').default('development'),

  PROFILE_BILLING_ENABLED: Joi.boolean().default(true),
  TERMS_URL: Joi.string()
    .uri({ scheme: ['https'] })
    .optional()
    .allow(''),
  PRIVACY_URL: Joi.string()
    .uri({ scheme: ['https'] })
    .optional()
    .allow(''),
  SUBSCRIPTION_TERMS_URL: Joi.string()
    .uri({ scheme: ['https'] })
    .optional()
    .allow(''),
  PORT: Joi.number().port().default(3001),

  CORS_ORIGINS: Joi.string()
    .optional()
    .allow('')
    .description('Comma-separated list of allowed origins. Empty blocks all CORS.'),

  PUBLIC_URL: Joi.string().uri().default('http://localhost:3001'),

  SUPABASE_URL: Joi.string().uri().required(),
  SUPABASE_ANON_KEY: Joi.string().required(),
  SUPABASE_SERVICE_ROLE_KEY: Joi.string().required(),

  // HS256 secret for short-lived registration/reset tokens (not Supabase JWTs).
  AUTH_TOKEN_SECRET: Joi.string().min(32).required(),

  DATABASE_URL: Joi.string().required(),
  DIRECT_URL: Joi.string().required(),

  REDIS_URL: Joi.string().uri().default('redis://localhost:6379'),

  THROTTLE_TTL: Joi.number().integer().min(1000).default(60_000),
  THROTTLE_LIMIT: Joi.number().integer().min(1).default(100),
  THROTTLE_BLOCK_DURATION: Joi.number().integer().min(0).default(0),
  THROTTLE_STRICT_TTL: Joi.number().integer().min(1000).default(60_000),
  THROTTLE_STRICT_LIMIT: Joi.number().integer().min(1).default(5),
  THROTTLE_STRICT_BLOCK_DURATION: Joi.number().integer().min(0).default(300_000),

  RESEND_API_KEY: Joi.string().required(),
  RESEND_FROM_EMAIL: Joi.string().email().default('noreply@bonde.app'),
  MAIL_LOGO_URL: Joi.string()
    .uri({ scheme: ['https'] })
    .optional()
    .allow(''),
  MAIL_ASSET_BASE_URL: Joi.string()
    .uri({ scheme: ['https'] })
    .optional()
    .allow(''),

  TERMII_API_KEY: Joi.string().required(),
  TERMII_SENDER_ID: Joi.string().max(11).default('Bonde'),

  // FCM push delivery. Optional — when unset, `registerDevice` endpoints keep
  // working but `NotificationsService.create` skips push dispatch (in-app
  // notifications still record normally).
  //
  // Inline service-account JSON is the **primary** shape (works on stateless
  // hosts like Vercel serverless with no filesystem). The path forms are a
  // fallback for local dev and hosts that mount secrets. All three may be
  // empty — empty PATH/PROJECT_ID simply means "rely on the inline JSON".
  FIREBASE_SERVICE_ACCOUNT_JSON: Joi.string().optional().allow(''),
  FIREBASE_SERVICE_ACCOUNT_PATH: Joi.string().optional().allow(''),
  FIREBASE_PROJECT_ID: Joi.string().optional().allow(''),

  CARD_ENCRYPTION_KEY: Joi.string().hex().length(64).required(),

  /// Key used to encrypt TOTP secrets; defaults to CARD_ENCRYPTION_KEY.
  MFA_ENCRYPTION_KEY: Joi.string().hex().length(64).optional(),

  /// Base URL of the admin console; invite emails link to <base>/accept-invite.
  ADMIN_APP_URL: Joi.string().uri().default('http://localhost:3000'),

  /// Inbox that receives public website waitlist + contact notifications.
  CONTACT_INBOX_EMAIL: Joi.string().email().default('usebonde@gmail.com'),

  /// HMAC key for hashing identifiers at rest; defaults to CARD_ENCRYPTION_KEY.
  KYC_HASH_SECRET: Joi.string().hex().length(64).optional(),

  PASSCODE_MAX_ATTEMPTS: Joi.number().integer().min(1).default(5),
  PASSCODE_LOCK_MINUTES: Joi.number().integer().min(1).default(15),
});
