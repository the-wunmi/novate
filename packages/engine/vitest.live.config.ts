import { existsSync, readFileSync } from 'node:fs';
import { parseEnv } from 'node:util';
import { freshTestDatabases } from '@novate/db/test-databases';
import { defineConfig } from 'vitest/config';

const envFile = new URL('../../.env', import.meta.url);
const dotenv = existsSync(envFile) ? parseEnv(readFileSync(envFile, 'utf8')) : {};

/** Real Airwallex sandbox runs, on fresh databases. Only `pnpm test:live` runs these. */
export default defineConfig(async () => ({
  test: {
    include: ['test/**/*.live.test.ts'],
    fileParallelism: false,
    setupFiles: ['@novate/db/test-worker'],
    testTimeout: 600_000,
    hookTimeout: 600_000,
    env: { ...(dotenv as Record<string, string>), ...(await freshTestDatabases('engine_live', 1)) },
  },
}));
