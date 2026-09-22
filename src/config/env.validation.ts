import Joi from 'joi';

/**
 * Joi validation schema for environment variables.
 *
 * The application fails fast at boot if required variables are missing or
 * malformed, so misconfiguration never silently reaches a request handler.
 */
export const envValidationSchema = Joi.object({
  NODE_ENV: Joi.string().valid('development', 'production', 'test').default('development'),

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
  MAIL_LOGO_URL: Joi.string().uri().optional(),

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

  FLUTTERWAVE_BASE_URL: Joi.string().uri().default('https://api.flutterwave.com/v3'),
  FLUTTERWAVE_SECRET_KEY: Joi.string().required(),
  FLUTTERWAVE_WEBHOOK_SECRET_HASH: Joi.string().required(),
  FLUTTERWAVE_VA_BANK_CODE: Joi.string().max(10).default('090567'),

  PASSCODE_MAX_ATTEMPTS: Joi.number().integer().min(1).default(5),
  PASSCODE_LOCK_MINUTES: Joi.number().integer().min(1).default(15),
});
