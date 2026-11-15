import { fileURLToPath } from 'node:url';
import { migrate } from 'drizzle-orm/node-postgres/migrator';
import { installAuditTriggers } from './audit.ts';
import { createDb, createPool } from './client.ts';

/** Bring the schema up to date, then install the audit triggers every table's class calls for. */
export async function runMigrations(url = process.env.DATABASE_URL): Promise<void> {
  // Migrations run one statement at a time, so one connection is all they use.
  const pool = createPool(url, 1);
  try {
    await migrate(createDb(pool), {
      migrationsFolder: fileURLToPath(new URL('../drizzle', import.meta.url)),
    });
    const client = await pool.connect();
    try {
      await installAuditTriggers(client);
    } finally {
      client.release();
    }
  } finally {
    await pool.end();
  }
}

if (import.meta.url === `file://${process.argv[1]}`) {
  await runMigrations();
  console.log('migrations applied');
}
