import { defineConfig } from 'vitest/config';

import { decoratorMetadata } from './vitest.config.js';

/**
 * Integration tests: `test/**\/*.int.test.ts` against real TimescaleDB/PostGIS
 * and NATS containers started once by `test/support/global-setup.ts`
 * (`pnpm test:int`, Docker required). Files run one after another because they
 * share the containers.
 */
export default defineConfig({
  plugins: [decoratorMetadata],
  test: {
    name: 'integration',
    environment: 'node',
    include: ['test/**/*.int.test.ts'],
    globalSetup: ['test/support/global-setup.ts'],
    fileParallelism: false,
    maxWorkers: 1,
    testTimeout: 60_000,
    hookTimeout: 180_000,
    // Containers are stopped by the global setup's teardown (CI may use Ryuk instead).
    env: { TESTCONTAINERS_RYUK_DISABLED: 'true' },
  },
});
