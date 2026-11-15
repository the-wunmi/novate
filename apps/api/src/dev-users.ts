import { ensureDemoUsers } from './demo-users.ts';

/**
 * `pnpm dev:users`: a house and a platform user, and a member user once the demo's Homeware brand
 * exists, with known passwords on the local development
 * database, to try the console. Refused anywhere but a local `novate` or `novate_demo` database,
 * and in production.
 */
const url = process.env.DATABASE_URL;
if (!url) throw new Error('DATABASE_URL is not set');
const made = await ensureDemoUsers(url, ['novate', 'novate_demo']);
const port = process.env.PORT ?? '4000';
console.log(`\nSign in at http://localhost:${port}/console/ (local only):\n`);
for (const u of made) console.log(`  ${u.role.padEnd(8)} ${u.email}  password ${u.password}`);
console.log('');
