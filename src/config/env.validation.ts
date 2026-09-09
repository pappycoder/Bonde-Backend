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

  DATABASE_URL: Joi.string().required(),
  DIRECT_URL: Joi.string().required(),

  REDIS_URL: Joi.string().uri().default('redis://localhost:6379'),
});
