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
  database: {
    url: string;
    directUrl: string;
  };
  redis: {
    url: string;
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
  database: {
    url: process.env.DATABASE_URL!,
    directUrl: process.env.DIRECT_URL!,
  },
  redis: {
    url: process.env.REDIS_URL ?? 'redis://localhost:6379',
  },
});
