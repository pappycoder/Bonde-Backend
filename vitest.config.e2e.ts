import { defineConfig } from 'vitest/config';
import tsconfigPaths from 'vite-tsconfig-paths';

export default defineConfig({
  plugins: [tsconfigPaths()],
  test: {
    globals: true,
    root: './',
    // Regular integration tests must not inherit paid providers or a remote
    // cache from a developer's .env. Provider-specific suites inject fakes;
    // real OpenAI/Brave calls belong only to the explicit smoke command.
    env: {
      AI_SHOPPING_ENABLED: 'false',
      OPENAI_API_KEY: '',
      BRAVE_SEARCH_API_KEY: '',
      AI_USAGE_MONITORING_ENABLED: 'false',
      SERVICE_PURCHASES_ENABLED: 'false',
      FINANCE_ENABLED: 'false',
      DATABASE_URL: 'postgresql://bonde:bonde@127.0.0.1:5433/bonde',
      DIRECT_URL: 'postgresql://bonde:bonde@127.0.0.1:5433/bonde',
      REDIS_URL: 'redis://127.0.0.1:6379',
    },
    include: ['**/*.e2e-spec.ts'],
    globalSetup: ['./test/global-setup.ts'],
    fileParallelism: false,
    // Each e2e boots full Nest apps against local docker services; under a
    // busy host the 5s default makes load-sensitive asserts flap. The boot
    // hook itself may straddle a transient Redis/Docker stall, so give it
    // headroom beyond `waitForRedisReady`'s 30s.
    testTimeout: 30_000,
    hookTimeout: 90_000,
  },
});
