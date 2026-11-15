import { freshTestDatabases } from '@novate/db/test-databases';
import { defineConfig } from 'vitest/config';

export default defineConfig(async () => ({
  test: { env: await freshTestDatabases('ledger') },
}));
