import { defineConfig } from 'vitest/config';
import tsconfigPaths from 'vite-tsconfig-paths';

export default defineConfig({
  plugins: [tsconfigPaths()],
  test: {
    globals: true,
    root: './',
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