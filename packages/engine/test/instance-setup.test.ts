import { randomUUID } from 'node:crypto';
import {
  apiKeys,
  createDb,
  createPool,
  type Db,
  instanceSetup,
  tenants,
  userInvites,
  users,
} from '@novate/db';
import { runMigrations } from '@novate/db/migrate';
import { testPoolSize } from '@novate/db/test-databases';
import { sql } from 'drizzle-orm';
import pg from 'pg';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { configureAuth } from '../src/auth-config.ts';
import { hashToken } from '../src/auth-crypto.ts';
import { operatorKeyIsValid, resetOperatorKey, setUpInstance } from '../src/instance-setup.ts';
import { inviteToken } from '../src/users.ts';
import { testAuth } from './harness.ts';

// Its own database: a first run can only be seen where nothing has run yet.
const name = `novate_setup_${randomUUID().replaceAll('-', '')}`;
let admin: pg.Client;
let pool: ReturnType<typeof createPool>;
let db: Db;

beforeAll(async () => {
  configureAuth(testAuth);
  const base = process.env.DATABASE_URL as string;
  admin = new pg.Client({ connectionString: base });
  await admin.connect();
  await admin.query(`create database ${name}`);
  const url = new URL(base);
  url.pathname = `/${name}`;
  await runMigrations(url.toString());
  pool = createPool(url.toString(), testPoolSize);
  db = createDb(pool);
}, 60_000);

afterAll(async () => {
  await pool?.end();
  await admin?.query(`drop database if exists ${name}`);
  await admin?.end();
});

beforeEach(async () => {
  // People are never removed, so the reset runs with triggers off, as only a superuser can.
  await db.transaction(async (t) => {
    await t.execute(sql`set local session_replication_role = replica`);
    for (const table of [
      'instance_setup',
      'sessions',
      'user_invites',
      'users',
      'api_keys',
      'tenants',
    ])
      await t.execute(sql.raw(`delete from ${table}`));
  });
});

describe('first boot', () => {
  it('creates the operator, a default tenant and the rail owners, storing only hashes', async () => {
    const state = await setUpInstance(db, ['airwallex', 'metal']);
    const first = state.firstRun as NonNullable<typeof state.firstRun>;
    expect(await operatorKeyIsValid(db, first.operatorKey)).toBe(true);
    expect(state.railOwners).toEqual({ airwallex: first.tenantId, metal: first.tenantId });

    const stored = JSON.stringify([
      await db.select().from(instanceSetup),
      await db.select().from(apiKeys),
    ]);
    expect(stored).not.toContain(first.operatorKey);
    expect(stored).not.toContain(first.platformKey);
    expect(stored).toContain(hashToken(first.platformKey));
  });

  it('invites a first house and platform user, storing only the invite hashes', async () => {
    const state = await setUpInstance(db, ['airwallex'], {
      house: 'Ops@Example.com',
      platform: 'platform@example.com',
    });
    const first = state.firstRun as NonNullable<typeof state.firstRun>;
    expect(first.invites.map((i) => [i.role, i.email])).toEqual([
      ['house', 'ops@example.com'],
      ['platform', 'platform@example.com'],
    ]);
    const people = await db.select().from(users).orderBy(users.role);
    expect(people.map((u) => [u.role, u.status, u.tenantId])).toEqual([
      ['house', 'invited', first.tenantId],
      ['platform', 'invited', first.tenantId],
    ]);
    const stored = JSON.stringify([people, await db.select().from(userInvites)]);
    for (const invite of first.invites) {
      const token = inviteToken(invite.inviteUrl);
      expect(invite.inviteUrl).toMatch(/\/console\/#\/invite\//);
      expect(stored).not.toContain(token);
      expect(stored).toContain(hashToken(token));
    }
  });

  it('does nothing the second time, and shows no keys', async () => {
    const first = await setUpInstance(db, ['airwallex']);
    const second = await setUpInstance(db, ['airwallex']);
    expect(second.firstRun).toBeUndefined();
    expect(second.railOwners).toEqual(first.railOwners);
    expect(await db.select().from(tenants)).toHaveLength(1);
    expect(await db.select().from(instanceSetup)).toHaveLength(1);
  });

  it('runs once when two processes start together', async () => {
    const results = await Promise.all([setUpInstance(db, ['a']), setUpInstance(db, ['a'])]);
    expect(results.filter((r) => r.firstRun)).toHaveLength(1);
    expect(await db.select().from(tenants)).toHaveLength(1);
  });

  it('counts tenants left by earlier use as nothing to do with the first run', async () => {
    await db.insert(tenants).values([{ name: 'old one' }, { name: 'old two' }]);
    const state = await setUpInstance(db, ['airwallex']);
    expect(state.railOwners.airwallex).toBe(state.firstRun?.tenantId);
  });
});

describe('rail ownership', () => {
  it('stays put when more tenants arrive', async () => {
    const first = await setUpInstance(db, ['airwallex']);
    await db.insert(tenants).values({ name: 'a later platform' });
    expect((await setUpInstance(db, ['airwallex'])).railOwners).toEqual(first.railOwners);
  });

  it('gives a rail added later to the default tenant', async () => {
    const first = await setUpInstance(db, ['airwallex']);
    const later = await setUpInstance(db, ['airwallex', 'metal']);
    expect(later.railOwners.metal).toBe(first.firstRun?.tenantId);
  });

  it('leaves out a rail that is no longer running', async () => {
    await setUpInstance(db, ['airwallex', 'metal']);
    expect(Object.keys((await setUpInstance(db, ['airwallex'])).railOwners)).toEqual(['airwallex']);
  });
});

describe('losing the operator key', () => {
  it('replaces it, and the old one stops working', async () => {
    const { firstRun } = await setUpInstance(db, []);
    const fresh = await resetOperatorKey(db);
    expect(await operatorKeyIsValid(db, firstRun?.operatorKey as string)).toBe(false);
    expect(await operatorKeyIsValid(db, fresh)).toBe(true);
  });
});
