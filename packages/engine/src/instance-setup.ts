import { createHash, randomBytes } from 'node:crypto';
import { apiKeys, type Db, instanceSetup, tenants } from '@novate/db';
import { eq, sql } from 'drizzle-orm';
import { deps } from './deps.ts';

/** Held for the length of setup, so two processes starting together cannot both do the first run. */
const SETUP_LOCK = 7_210_041;

export const hashKey = (key: string) => createHash('sha256').update(key).digest('hex');
export const newKey = () => `nov_${randomBytes(24).toString('hex')}`;

/** Only the first boot has these. They are shown once, and only their hashes are stored. */
export interface FirstRun {
  operatorKey: string;
  platformKey: string;
  tenantId: string;
}

export interface InstanceState {
  railOwners: Record<string, string>;
  firstRun?: FirstRun;
}

const DEFAULT_TENANT_NAME = 'Default';

/**
 * Make sure this installation has an operator and a default tenant. The default tenant owns every
 * running rail, and it never changes, so adding tenants never moves the money.
 */
export function setUpInstance(db: Db, rails: string[]): Promise<InstanceState> {
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
        keyHash: hashKey(platformKey),
      });
      await t
        .insert(instanceSetup)
        .values({ defaultTenantId: tenantId, operatorKeyHash: hashKey(operatorKey) });
      firstRun = { operatorKey, platformKey, tenantId };
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
    .where(eq(instanceSetup.operatorKeyHash, hashKey(key)));
  return found.length > 0;
}

export const isOperatorKey = (key: string) => operatorKeyIsValid(deps().db, key);

/** The way back in after losing the operator key. The old key stops working. */
export async function resetOperatorKey(db: Db): Promise<string> {
  const key = newKey();
  const updated = await db
    .update(instanceSetup)
    .set({ operatorKeyHash: hashKey(key) })
    .returning({ id: instanceSetup.id });
  if (!updated.length)
    throw new Error('This installation has not been set up yet. Start the server.');
  return key;
}
