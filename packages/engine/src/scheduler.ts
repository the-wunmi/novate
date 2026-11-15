import { DBOS } from '@dbos-inc/dbos-sdk';
import { apiRateWindows, cycles, obligations, tenants } from '@novate/db';
import { durationMs } from '@novate/policy';
import { and, desc, eq, lt } from 'drizzle-orm';
import { cycleWorkflow } from './cycle-workflow.ts';
import { deps, tx } from './deps.ts';
import { sampleFxRates } from './fx-signal.ts';
import { monitorWorkflow } from './monitor.ts';
import { pollRailEvents } from './rail-events.ts';
import { reconWorkflow } from './reconciliation.ts';
import { eligibleGroups } from './service.ts';
import { parseGroup, stableUuid } from './settlement-group.ts';

/** A group whose only cycle was halted or deferred is tried again this soon. */
const RETRY_DEAL_GROUP_MS = 60_000;

async function dueGroups(tenantId: string, now: Date) {
  return tx('due_groups', async (db) => {
    const due: { group: string; every: number }[] = [];
    for (const group of await eligibleGroups(db, tenantId)) {
      const { timing } = parseGroup(group);
      if (timing === 'manual') continue;
      const every = timing.startsWith('every:')
        ? durationMs(timing.slice('every:'.length))
        : RETRY_DEAL_GROUP_MS;
      const [last] = await db
        .select({ createdAt: cycles.createdAt })
        .from(cycles)
        .where(and(eq(cycles.tenantId, tenantId), eq(cycles.settlementGroup, group)))
        .orderBy(desc(cycles.createdAt))
        .limit(1);
      if (!last || now.getTime() - last.createdAt.getTime() >= every) due.push({ group, every });
    }
    return due;
  });
}

/** Start a cycle for every settlement group that has come due. Safe to repeat. */
export async function settleDueGroups(tenantId: string, now: Date): Promise<string[]> {
  const started: string[] = [];
  for (const { group, every } of await dueGroups(tenantId, now)) {
    const slot = Math.floor(now.getTime() / every);
    const cycleId = stableUuid(`${tenantId}:${group}:${slot}`);
    await DBOS.startWorkflow(cycleWorkflow, { workflowID: cycleId })(
      tenantId,
      cycleId,
      group,
      true,
    );
    started.push(cycleId);
  }
  return started;
}

const allTenants = () => tx('tenants', (db) => db.select({ id: tenants.id }).from(tenants));

async function settlementTick(scheduled: Date): Promise<void> {
  const waiting = await tx('tenants_with_eligible', (db) =>
    db
      .selectDistinct({ id: obligations.tenantId })
      .from(obligations)
      .where(eq(obligations.status, 'eligible')),
  );
  for (const t of waiting) await settleDueGroups(t.id, scheduled);
}

export const settlementTickWorkflow = DBOS.registerWorkflow(settlementTick, {
  name: 'settlementTick',
});

async function reconTick(scheduled: Date): Promise<void> {
  const slot = scheduled.toISOString();
  // Only the owning tenant: anyone else would see the whole account as differences and halt.
  for (const [rail, tenantId] of Object.entries(deps().railOwners)) {
    await DBOS.startWorkflow(reconWorkflow, {
      workflowID: stableUuid(`recon:${tenantId}:${rail}:${slot}`),
    })(tenantId, rail);
  }
}
export const reconTickWorkflow = DBOS.registerWorkflow(reconTick, { name: 'reconTick' });

async function monitorTick(scheduled: Date): Promise<void> {
  const expired = new Date(scheduled.getTime() - 3_600_000);
  await tx('rate_windows_cleanup', (db) =>
    db.delete(apiRateWindows).where(lt(apiRateWindows.windowStart, expired)),
  );
  const slot = scheduled.toISOString();
  for (const t of await allTenants()) {
    await DBOS.startWorkflow(monitorWorkflow, {
      workflowID: stableUuid(`monitor:${t.id}:${slot}`),
    })(t.id);
  }
}
export const monitorTickWorkflow = DBOS.registerWorkflow(monitorTick, { name: 'monitorTick' });

async function fxTick(_scheduled: Date): Promise<void> {
  await DBOS.runStep(() => sampleFxRates(), { name: 'sample_fx' });
}
export const fxTickWorkflow = DBOS.registerWorkflow(fxTick, { name: 'fxTick' });

async function railPollTick(_scheduled: Date): Promise<void> {
  for (const rail of deps().rails.all()) await pollRailEvents(rail);
}
export const railPollTickWorkflow = DBOS.registerWorkflow(railPollTick, { name: 'railPollTick' });

export async function applyTickSchedules(): Promise<void> {
  await DBOS.applySchedules([
    { scheduleName: 'settlement', workflowFn: settlementTickWorkflow, schedule: '* * * * *' },
    { scheduleName: 'reconciliation', workflowFn: reconTickWorkflow, schedule: '*/15 * * * *' },
    { scheduleName: 'rail-poll', workflowFn: railPollTickWorkflow, schedule: '* * * * *' },
    { scheduleName: 'fx-samples', workflowFn: fxTickWorkflow, schedule: '0 * * * *' },
    { scheduleName: 'monitor', workflowFn: monitorTickWorkflow, schedule: '*/5 * * * *' },
  ]);
}

/** Read the rails now rather than at the next tick. */
export const pollRailsNow = async () =>
  (await DBOS.startWorkflow(railPollTickWorkflow)(new Date())).getResult();
