import { createDb, createPool } from '@novate/db';
import { resetOperatorKey } from '@novate/engine';

// Replaces every operator key. Run on the machine holding the database, never over the API.
const pool = createPool();
try {
  console.log(`New operator key, shown once:\n\n${await resetOperatorKey(createDb(pool))}\n`);
} finally {
  await pool.end();
}
