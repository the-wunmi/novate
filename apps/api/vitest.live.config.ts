import { existsSync, readFileSync } from 'node:fs';
import { parseEnv } from 'node:util';
import { defineConfig } from 'vitest/config';

const envFile = new URL('../../.env', import.meta.url);
const dotenv = existsSync(envFile) ? parseEnv(readFileSync(envFile, 'utf8')) : {};

/**
 * Real Airwallex, Claude and Metal, with credentials from `.env`. Only `pnpm test:live` runs them.
 */
export default defineConfig({
  test: {
    include: ['test/**/*.live.test.ts'],
    fileParallelism: false,
    testTimeout: 600_000,
    hookTimeout: 600_000,
    env: dotenv as Record<string, string>,
  },
});
