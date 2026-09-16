/**
 * Typed view over validated environment configuration.
 *
 * Consume via `ConfigService<AppConfig, true>` so lookups are type-checked at
 * compile time. Values are normalized here (e.g. splitting CSV origins), so
 * feature modules never touch raw `process.env` directly.
 */
export interface AppConfig {
  nodeEnv: string;
  port: number;
  corsOrigins: string[];
  publicUrl: string;
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
  };
  termii: {
    apiKey: string;
    senderId: string;
  };
  push: {
    /// Path to the FCM service-account JSON. Empty/absent disables push
    /// delivery (dev-local apps still get in-app notifications).
    fcmServiceAccountPath?: string;
    /// Firebase project id used when initializing the FCM app (also present
    /// inside the service-account JSON).
    fcmProjectId?: string;
  };
  encryption: {
    cardKey: string;
  };
  flutterwave: {
    baseUrl: string;
    secretKey: string;
    webhookSecretHash: string;
    vaBankCode: string;
  };
}

export default (): AppConfig => ({
  nodeEnv: process.env.NODE_ENV ?? 'development',
  port: Number(process.env.PORT ?? 3001),
  corsOrigins: (process.env.CORS_ORIGINS ?? '')
    .split(',')
    .map((origin) => origin.trim())
    .filter(Boolean),
  publicUrl: process.env.PUBLIC_URL ?? 'http://localhost:3001',
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
  },
  termii: {
    apiKey: process.env.TERMII_API_KEY!,
    senderId: process.env.TERMII_SENDER_ID ?? 'Bonde',
  },
  encryption: {
    cardKey: process.env.CARD_ENCRYPTION_KEY!,
  },
  flutterwave: {
    baseUrl: process.env.FLUTTERWAVE_BASE_URL ?? 'https://api.flutterwave.com/v3',
    secretKey: process.env.FLUTTERWAVE_SECRET_KEY!,
    webhookSecretHash: process.env.FLUTTERWAVE_WEBHOOK_SECRET_HASH!,
    vaBankCode: process.env.FLUTTERWAVE_VA_BANK_CODE ?? '090567',
  },
  push: {
    fcmServiceAccountPath: process.env.FIREBASE_SERVICE_ACCOUNT_PATH,
    fcmProjectId: process.env.FIREBASE_PROJECT_ID,
  },
});
