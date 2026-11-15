import { randomBytes } from 'node:crypto';
import type { UserRole } from '@novate/core';
import { apiKeys, type Db, instanceSetup, tenants } from '@novate/db';
import { eq, sql } from 'drizzle-orm';
import { hashToken } from './auth-crypto.ts';
import { operatorActor } from './control.ts';
import { deps } from './deps.ts';
import { inviteFirstUsers } from './users.ts';

/** Held for the length of setup, so two processes starting together cannot both do the first run. */
const SETUP_LOCK = 7_210_041;

export const newKey = () => `nov_${randomBytes(24).toString('hex')}`;

/** Only the first boot has these. They are shown once, and only their hashes are stored. */
export interface FirstRun {
  operatorKey: string;
  platformKey: string;
  tenantId: string;
  /** The first house and platform users, each with a link to set a password. */
  invites: { role: UserRole; email: string; inviteUrl: string }[];
}

/** Who the first boot invites. */
export interface FirstUsers {
  house: string;
  platform: string;
}

export const DEFAULT_FIRST_USERS: FirstUsers = {
  house: 'admin@localhost',
  platform: 'platform@localhost',
};

export interface InstanceState {
  railOwners: Record<string, string>;
  firstRun?: FirstRun;
}

const DEFAULT_TENANT_NAME = 'Default';

/**
 * Make sure this installation has an operator and a default tenant. The default tenant owns every
 * running rail, and it never changes, so adding tenants never moves the money.
 */
export function setUpInstance(
  db: Db,
  rails: string[],
  firstUsers: FirstUsers = DEFAULT_FIRST_USERS,
): Promise<InstanceState> {
  return db.transaction(async (t) => {
    await t.execute(sql`select pg_advisory_xact_lock(${SETUP_LOCK})`);
    const [existing] = await t.select().from(instanceSetup);
    let firstRun: FirstRun | undefined;
    let tenantId = existing?.defaultTenantId;
    if (!tenantId) {
      const [tenant] = await t
        .insert(tenants)
        .values({ name: DEFAULT_TENANT_NAME })
        .returning({ id: tenants.id });
      tenantId = (tenant as { id: string }).id;
      const operatorKey = newKey();
      const platformKey = newKey();
      await t.insert(apiKeys).values({
        tenantId,
        name: 'platform',
        principal: 'platform',
        keyHash: hashToken(platformKey),
        createdBy: operatorActor('first boot'),
      });
      await t
        .insert(instanceSetup)
        .values({ defaultTenantId: tenantId, operatorKeyHash: hashToken(operatorKey) });
      const invites = await inviteFirstUsers(t, tenantId, firstUsers);
      firstRun = { operatorKey, platformKey, tenantId, invites };
    }
    const owner = tenantId;
    return {
      railOwners: Object.fromEntries(rails.map((rail) => [rail, owner])),
      ...(firstRun ? { firstRun } : {}),
    };
  });
}

export async function operatorKeyIsValid(db: Db, key: string): Promise<boolean> {
  const found = await db
    .select({ hash: instanceSetup.operatorKeyHash })
    .from(instanceSetup)
    .where(eq(instanceSetup.operatorKeyHash, hashToken(key)));
  return found.length > 0;
}

export const isOperatorKey = (key: string) => operatorKeyIsValid(deps().db, key);

/** The way back in after losing the operator key. The old key stops working. */
export async function resetOperatorKey(db: Db): Promise<string> {
  const key = newKey();
  const updated = await db
    .update(instanceSetup)
    .set({ operatorKeyHash: hashToken(key) })
    .returning({ id: instanceSetup.id });
  if (!updated.length) throw notSetUp();
  return key;
}

const notSetUp = () => new Error('This installation has not been set up yet. Start the server.');

/** The tenant the first boot made, which owns every rail. For command-line tools. */
export async function defaultTenantId(db: Db): Promise<string> {
  const [setup] = await db.select().from(instanceSetup);
  if (!setup) throw notSetUp();
  return setup.defaultTenantId;
}
