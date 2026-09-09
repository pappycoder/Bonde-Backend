import 'dotenv/config';
import { defineConfig, env } from 'prisma/config';

/**
 * Prisma CLI configuration (Prisma 7+).
 *
 * Connection URLs moved out of schema.prisma into this file. The CLI uses the
 * DIRECT connection for migrations (port 5432), while the app runtime uses the
 * pooled DATABASE_URL via the @prisma/adapter-pg driver adapter.
 */
export default defineConfig({
  schema: 'prisma/schema.prisma',
  migrations: {
    path: 'prisma/migrations',
  },
  datasource: {
    url: env('DIRECT_URL'),
  },
});
