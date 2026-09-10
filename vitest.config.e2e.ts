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
    // busy host the 5s default makes load-sensitive asserts flap.
    testTimeout: 30_000,
    hookTimeout: 30_000,
  },
});