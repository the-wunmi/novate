import { freshTestDatabases, testWorkers } from '@novate/db/test-databases';
import { defineConfig } from 'vitest/config';

export default defineConfig(async () => ({
  test: {
    maxWorkers: testWorkers.ledger,
    setupFiles: ['@novate/db/test-worker'],
    env: await freshTestDatabases('ledger', testWorkers.ledger),
  },
}));
