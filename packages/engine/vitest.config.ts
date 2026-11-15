import { freshTestDatabases, testWorkers } from '@novate/db/test-databases';
import { configDefaults, defineConfig } from 'vitest/config';

// Each worker gets its own databases, so files run in parallel.
const workers = testWorkers.engine;

export default defineConfig(async () => ({
  test: {
    // Live tests reach real rails and models. Only `pnpm test:live` runs them.
    exclude: [...configDefaults.exclude, '**/*.live.test.ts'],
    maxWorkers: workers,
    setupFiles: ['@novate/db/test-worker'],
    testTimeout: 60_000,
    hookTimeout: 60_000,
    env: await freshTestDatabases('engine', workers),
  },
}));
