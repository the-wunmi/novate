import {
  type ControlActor,
  DomainError,
  type Principal,
  parseInput,
  TenantSettings,
} from '@novate/core';
import { type Tx, tenants } from '@novate/db';
import { eq } from 'drizzle-orm';
import { z } from 'zod';
import { actorOf, personOf, Reason, recordControl } from './control.ts';
import { deps, tx } from './deps.ts';
import { lockTenantFor } from './repo.ts';

/** The tenant's settings, read inside the caller's transaction. */
export async function tenantSettings(db: Tx, tenantId: string): Promise<TenantSettings> {
  const [row] = await db
    .select({ settings: tenants.settings })
    .from(tenants)
    .where(eq(tenants.id, tenantId));
  if (!row) throw new DomainError('not_found', 'Tenant not found');
  return TenantSettings.parse(row.settings);
}

export const readTenantSettings = (tenantId: string) =>
  tenantSettings(deps().db as unknown as Tx, tenantId);

/** Whether an amount needs a second person: strictly above the currency's threshold. */
export const needsFourEyes = (settings: TenantSettings, currency: string, amount: bigint) =>
  amount > (settings.fourEyesAbove[currency] ?? 0n);

const { requireTwoStep, timeZone, fourEyesAbove } = TenantSettings.shape;

/** Only what is given changes. `fourEyesAbove` replaces the whole map. */
export const UpdateSettings = z
  .object({
    requireTwoStep: requireTwoStep.unwrap().optional(),
    timeZone: timeZone.unwrap().optional(),
    fourEyesAbove: fourEyesAbove.unwrap().optional(),
    reason: Reason,
  })
  .refine(
    (s) =>
      s.requireTwoStep !== undefined || s.timeZone !== undefined || s.fourEyesAbove !== undefined,
    { message: 'Change at least one setting' },
  );

/** Write settings and record what changed, from what, and why. */
export async function writeSettings(
  db: Tx,
  tenantId: string,
  actor: ControlActor,
  change: Partial<TenantSettings>,
  reason: string,
) {
  await lockTenantFor(db, tenantId, 'settings');
  const before = await tenantSettings(db, tenantId);
  const after: TenantSettings = { ...before, ...change };
  await db.update(tenants).set({ settings: after }).where(eq(tenants.id, tenantId));
  await recordControl(db, tenantId, actor, {
    type: 'settings_changed',
    reason,
    payload: { from: before, to: after, changed: Object.keys(change) },
  });
  return after;
}

/**
 * The house changes its own controls: two-step sign-in, the four-eyes thresholds, the time zone of
 * its business day. A signed-in house person only, with a reason, every change recorded.
 */
export async function updateTenantSettings(
  tenantId: string,
  principal: Principal,
  input: z.input<typeof UpdateSettings>,
) {
  const { reason, ...change } = parseInput(UpdateSettings, input);
  if (principal.kind !== 'house') throw new DomainError('forbidden', 'Only the house sets these');
  personOf(principal, 'change the house controls');
  return tx('update_settings', (db) =>
    writeSettings(db, tenantId, actorOf(principal), change, reason),
  );
}
