import pg from 'pg';
import {
  AUDIT_TABLES,
  CASE_COLUMNS,
  CASE_TABLE,
  HISTORIED_TABLES,
  NEVER_REMOVED_TABLES,
} from './audit.ts';

/** Statements that give `role` what the server needs and no more. Safe to run again. */
export function leastPrivilegeSql(role: string): string[] {
  if (!/^[a-z_][a-z0-9_]{0,62}$/.test(role)) throw new Error(`Not a plain role name: ${role}`);
  const audit = AUDIT_TABLES.join(', ');
  return [
    `DO $$ BEGIN
       IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = '${role}') THEN
         CREATE ROLE ${role} LOGIN;
       END IF;
     END $$`,
    `GRANT USAGE ON SCHEMA public TO ${role}`,
    `REVOKE ALL ON ALL TABLES IN SCHEMA public FROM ${role}`,
    `GRANT SELECT, INSERT, UPDATE, DELETE ON ALL TABLES IN SCHEMA public TO ${role}`,
    `GRANT USAGE, SELECT ON ALL SEQUENCES IN SCHEMA public TO ${role}`,
    `REVOKE UPDATE, DELETE, TRUNCATE ON ${audit} FROM ${role}`,
    `REVOKE DELETE, TRUNCATE ON ${HISTORIED_TABLES.join(', ')} FROM ${role}`,
    `REVOKE DELETE, TRUNCATE ON ${NEVER_REMOVED_TABLES.join(', ')} FROM ${role}`,
    `REVOKE UPDATE, DELETE, TRUNCATE ON ${CASE_TABLE} FROM ${role}`,
    `GRANT UPDATE (${CASE_COLUMNS.join(', ')}) ON ${CASE_TABLE} TO ${role}`,
  ];
}

/**
 * Apply the grants as the owner, in one transaction so the running server never sees a gap.
 * Run after every migration: tables a migration adds start with no rights for `role`.
 */
export async function grantAppRole(ownerUrl: string, role = 'novate_app'): Promise<void> {
  const client = new pg.Client({ connectionString: ownerUrl });
  await client.connect();
  try {
    await client.query('BEGIN');
    for (const statement of leastPrivilegeSql(role)) await client.query(statement);
    await client.query('COMMIT');
  } catch (err) {
    await client.query('ROLLBACK');
    throw err;
  } finally {
    await client.end();
  }
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const url = process.env.NOVATE_MIGRATION_DATABASE_URL ?? process.env.DATABASE_URL;
  if (!url) throw new Error('Set NOVATE_MIGRATION_DATABASE_URL to the owner connection');
  const role = process.argv[2] ?? 'novate_app';
  await grantAppRole(url, role);
  console.log(`${role} may read and append to the audit tables, and nothing more`);
}
