import { randomUUID } from 'node:crypto';
import { schema } from '@novate/db';
import {
  AUDIT_TABLES,
  AUDIT_TRIGGERS,
  CASE_TABLE,
  HISTORIED_TABLES,
  MUTABLE_TABLES,
  NEVER_REMOVED_TABLES,
} from '@novate/db/audit';
import { grantAppRole } from '@novate/db/least-privilege';
import { runMigrations } from '@novate/db/migrate';
import { getTableName, is } from 'drizzle-orm';
import { PgTable } from 'drizzle-orm/pg-core';
import pg from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

// Roles belong to the whole server, so this one has a name no other run can share.
const role = `novate_app_${randomUUID().slice(0, 8)}`;
const url = process.env.DATABASE_URL as string;
let client: pg.Client;

beforeAll(async () => {
  await runMigrations(url);
  await grantAppRole(url, role);
  // Twice, as every boot after a migration does.
  await grantAppRole(url, role);
  client = new pg.Client({ connectionString: url });
  await client.connect();
}, 60_000);

afterAll(async () => {
  await client?.query(`drop owned by ${role}`);
  await client?.query(`drop role if exists ${role}`);
  await client?.end();
});

/** Run as the application role, and undo whatever it did. */
async function asApp(statement: string) {
  await client.query('begin');
  try {
    await client.query(`set local role ${role}`);
    await client.query(statement);
  } finally {
    await client.query('rollback');
  }
}

describe('the application role', () => {
  it('reads and appends to the audit trail, and cannot change it', async () => {
    await asApp('select 1 from ledger_transfers limit 1');
    await asApp('select 1 from control_events limit 1');
    for (const statement of [
      'update ledger_transfers set amount = 0 where false',
      'delete from control_events where false',
      `update recon_runs set status = 'clean' where false`,
      'delete from recon_break_resolutions where false',
      `update programs set note = '' where false`,
      'update decision_outcomes set verdict = verdict where false',
      'truncate decision_records',
      `update decision_cases set shown = '{}' where false`,
      'delete from decision_cases where false',
      'update approval_requests set reason = reason where false',
      'delete from approval_decisions where false',
      'update row_history set op = op where false',
      'delete from settlement_instructions where false',
      'delete from fx_conversions where false',
      'truncate rail_events',
    ]) {
      await expect(asApp(statement), statement).rejects.toThrow(/permission denied/);
    }
  });

  it('works everything else as before, a case’s status included', async () => {
    await asApp(`update decision_cases set status = 'open', closed_at = null where false`);
    await asApp('update members set name = name where false');
    await asApp('delete from api_rate_windows where false');
    // Payments still move through their statuses; each change is kept in row_history.
    await asApp(`update settlement_instructions set status = status where false`);
    await asApp('update rail_events set outcome = outcome where false');
    await asApp(
      'insert into row_history (table_name, row_id, op, old) select 1, 1, 1, null where false',
    );
  });
});

describe('the audit triggers', () => {
  it('classify every table in the schema exactly once', () => {
    const tables = Object.values(schema)
      .filter((v) => is(v, PgTable))
      .map((t) => getTableName(t as PgTable))
      .sort();
    const classified = [
      ...AUDIT_TABLES,
      ...HISTORIED_TABLES,
      ...NEVER_REMOVED_TABLES,
      CASE_TABLE,
      ...MUTABLE_TABLES,
    ].sort();
    expect(classified).toEqual(tables);
  });

  it('are all installed, once, however often the migrations run', async () => {
    await runMigrations(url);
    const { rows } = await client.query<{ name: string; table: string }>(
      `select t.tgname as name, c.relname as table
         from pg_trigger t join pg_class c on c.oid = t.tgrelid
        where not t.tgisinternal`,
    );
    const installed = rows.map((r) => `${r.table}.${r.name}`).sort();
    expect(installed).toEqual(AUDIT_TRIGGERS.map((t) => `${t.table}.${t.name}`).sort());
  });

  it('refuse a change to the audit trail and a removal of a person, whatever the role', async () => {
    await client.query('begin');
    try {
      const {
        rows: [tenant],
      } = await client.query<{ id: string }>(
        `insert into tenants (name) values ('audit triggers') returning id`,
      );
      await client.query(
        `insert into control_events (tenant_id, type, actor) values ($1, 'settlement_stopped', '{}')`,
        [tenant?.id],
      );
      await client.query(
        `insert into users (tenant_id, email, name, role, created_by)
           values ($1, 'audit@example.com', 'Audit', 'platform', '{}')`,
        [tenant?.id],
      );
      const refused = async (statement: string, why: RegExp) => {
        await client.query('savepoint attempt');
        await expect(client.query(statement), statement).rejects.toThrow(why);
        await client.query('rollback to savepoint attempt');
      };
      await refused(`update control_events set reason = 'x'`, /append-only/);
      await refused('delete from control_events', /append-only/);
      await refused('truncate control_events cascade', /cannot be truncated/);
      await refused('delete from users', /never removed/);
      await refused('truncate users cascade', /cannot be truncated/);
    } finally {
      await client.query('rollback');
    }
  });
});
