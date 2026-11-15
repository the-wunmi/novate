import { freshTestDatabases } from '@novate/db/test-databases';
import { defineConfig } from 'vitest/config';

export default defineConfig(async () => ({
  test: {
    fileParallelism: false,
    testTimeout: 60_000,
    hookTimeout: 60_000,
    env: await freshTestDatabases('engine'),
  },
}));
