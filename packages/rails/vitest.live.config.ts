import { existsSync, readFileSync } from 'node:fs';
import { parseEnv } from 'node:util';
import { defineConfig } from 'vitest/config';

const envFile = new URL('../../.env', import.meta.url);
const dotenv = existsSync(envFile) ? parseEnv(readFileSync(envFile, 'utf8')) : {};

/** Read-only checks against the real Airwallex sandbox and Metal. Only `pnpm test:live` runs them. */
export default defineConfig({
  test: {
    include: ['test/**/*.live.test.ts'],
    testTimeout: 60_000,
    env: dotenv as Record<string, string>,
  },
});
