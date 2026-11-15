import {
  type ControlActor,
  type DealStatus,
  DealTerms,
  DomainError,
  type StoredDealTerms,
} from '@novate/core';
import {
  agents,
  dealEvents,
  dealFacts,
  deals,
  type decisionCases,
  members,
  programs,
  settlementInstructions,
  type Tx,
  tenants,
} from '@novate/db';
import { Action, type Fact, ProgramSpec, type ResolvedPolicy } from '@novate/policy';
import type { SignalReading } from '@novate/signals';
import { and, asc, count, eq, gt, inArray, ne, notExists, sql } from 'drizzle-orm';
import { alias } from 'drizzle-orm/pg-core';
import { recordControl } from './control.ts';

export type DealRow = typeof deals.$inferSelect;
export type DealEventType = (typeof dealEvents.$inferInsert)['type'];

/** A deal as read models show it: its terms parsed, so amounts and defaults are filled in. */
export const withTerms = <T extends { terms: StoredDealTerms }>(deal: T) => ({
  ...deal,
  terms: DealTerms.parse(deal.terms),
});

/** The action that closed a decided case, parsed again so its amounts have their real types. */
export function decidedAction(c: typeof decisionCases.$inferSelect): Action {
  if (!c.resolution) throw new Error(`Case ${c.id} has not been decided`);
  return Action.parse(c.resolution.action);
}

const laterAttempt = alias(settlementInstructions, 'later_attempt');

/**
 * Holds for a settlement instruction that is the latest attempt at its payment: no retry of the
 * same cycle, member, currency and direction has replaced it.
 */
export const latestAttempt = (db: Tx) =>
  notExists(
    db
      .select({ one: sql`1` })
      .from(laterAttempt)
      .where(
        and(
          eq(laterAttempt.cycleId, settlementInstructions.cycleId),
          eq(laterAttempt.memberId, settlementInstructions.memberId),
          eq(laterAttempt.currency, settlementInstructions.currency),
          eq(laterAttempt.direction, settlementInstructions.direction),
          gt(laterAttempt.attempt, settlementInstructions.attempt),
        ),
      ),
  );
export type MemberRow = typeof members.$inferSelect;
export type AgentRow = typeof agents.$inferSelect;
export type ProgramRow = typeof programs.$inferSelect;

/** The policy a deal was accepted under, with what it was resolved from. */
export interface PolicySnapshot {
  programId: string;
  programVersion: number;
  resolved: ResolvedPolicy;
  signals: Record<string, SignalReading>;
  authorisedAt: string;
  /** Rate used to size locks in a member's home currency. Deal currency per home unit, ×10^8. */
  lockRates: Record<string, string>;
}

export const snapshotOf = (deal: DealRow) => deal.policySnapshot as unknown as PolicySnapshot;

export const signalValues = (signals: Record<string, SignalReading>) =>
  Object.fromEntries(Object.entries(signals).map(([k, v]) => [k, v.values]));

/** The currency a deal's buyer funds are locked in. */
export const escrowCurrency = (deal: Pick<DealRow, 'fundingCurrency' | 'currency'>) =>
  deal.fundingCurrency ?? deal.currency;

export async function getDeal(db: Tx, dealId: string): Promise<DealRow> {
  const [row] = await db.select().from(deals).where(eq(deals.id, dealId));
  if (!row) throw new DomainError('not_found', `Deal ${dealId} not found`);
  return row;
}

export async function getMember(db: Tx, memberId: string): Promise<MemberRow> {
  const [row] = await db.select().from(members).where(eq(members.id, memberId));
  if (!row) throw new DomainError('not_found', `Member ${memberId} not found`);
  return row;
}

export async function getAgent(db: Tx, agentId: string): Promise<AgentRow> {
  const [row] = await db.select().from(agents).where(eq(agents.id, agentId));
  if (!row) throw new DomainError('not_found', `Agent ${agentId} not found`);
  return row;
}

export async function getProgram(db: Tx, programId: string): Promise<ProgramRow> {
  const [row] = await db.select().from(programs).where(eq(programs.id, programId));
  if (!row) throw new DomainError('not_found', `Program ${programId} not found`);
  return row;
}

export async function loadProgramSpec(db: Tx, deal: DealRow): Promise<ProgramSpec> {
  return ProgramSpec.parse((await getProgram(db, deal.programId)).spec);
}

/** Belonging to the tenant is the access check, and a miss reads the same as not existing. */
export function inTenant<T extends { tenantId: string }>(
  row: T | undefined,
  tenantId: string,
  label: string,
): T {
  if (row?.tenantId !== tenantId) throw new DomainError('not_found', `${label} not found`);
  return row;
}

export const memberInTenant = async (db: Tx, tenantId: string, memberId: string) =>
  inTenant(await getMember(db, memberId), tenantId, 'Member');

export const agentInTenant = async (db: Tx, tenantId: string, agentId: string) =>
  inTenant(await getAgent(db, agentId), tenantId, 'Agent');

export const dealInTenant = async (db: Tx, tenantId: string, dealId: string) =>
  inTenant(await getDeal(db, dealId), tenantId, 'Deal');

/**
 * Serialise one kind of tenant-wide write, such as settings changes or the day's sign-off, until the
 * transaction ends. An advisory lock, not a lock on the tenant row, so it never holds up the
 * tenant's other writes.
 */
export async function lockTenantFor(db: Tx, tenantId: string, purpose: 'settings' | 'sign_off') {
  await db.execute(sql`select pg_advisory_xact_lock(hashtext(${`${tenantId}:${purpose}`}))`);
}

/**
 * Stop new settlement for a tenant until a signed-in person resumes it. The house stopping
 * itself again while already stopped changes nothing, so repeated checks do not flood the record
 * and the row's reason always belongs to the latest recorded stop.
 */
export async function haltSettlement(
  db: Tx,
  tenantId: string,
  actor: ControlActor,
  reason: string,
  payload?: Record<string, unknown>,
): Promise<void> {
  const [before] = await db
    .select({ haltedAt: tenants.settlementHaltedAt })
    .from(tenants)
    .where(eq(tenants.id, tenantId))
    .for('update');
  if (actor.kind === 'system' && before?.haltedAt) return;
  await db
    .update(tenants)
    .set({ settlementHaltedAt: new Date(), settlementHaltReason: reason })
    .where(eq(tenants.id, tenantId));
  await recordControl(db, tenantId, actor, { type: 'settlement_stopped', reason, payload });
}

export async function setStatus(
  db: Tx,
  dealId: string,
  status: DealStatus,
  event: { type: DealEventType; payload?: Record<string, unknown> },
  reason?: string | null,
): Promise<void> {
  await db
    .update(deals)
    .set({ status, ...(reason !== undefined ? { statusReason: reason } : {}) })
    .where(eq(deals.id, dealId));
  await record(db, dealId, event.type, { status, ...event.payload });
}

export async function record(
  db: Tx,
  dealId: string,
  type: DealEventType,
  payload: Record<string, unknown> = {},
): Promise<void> {
  const tenantId = sql<string>`(select ${deals.tenantId} from ${deals} where ${deals.id} = ${dealId})`;
  await db.insert(dealEvents).values({ tenantId, dealId, type, payload });
}

export async function listFacts(db: Tx, dealId: string): Promise<Fact[]> {
  const rows = await db
    .select()
    .from(dealFacts)
    .where(eq(dealFacts.dealId, dealId))
    .orderBy(asc(dealFacts.createdAt), asc(dealFacts.id));
  return rows.map((r) => ({
    id: r.id,
    kind: r.kind,
    type: r.type,
    source: r.source,
    data: r.data,
    createdAt: r.createdAt.toISOString(),
  }));
}

/** How members have funded earlier cycles, so one missed payment can be told from a pattern. */
export async function fundingRecords(
  db: Tx,
  tenantId: string,
  memberIds: string[],
  excludeCycleId?: string,
) {
  const rows = await db
    .select({
      memberId: settlementInstructions.memberId,
      status: settlementInstructions.status,
      n: count(),
    })
    .from(settlementInstructions)
    .where(
      and(
        eq(settlementInstructions.tenantId, tenantId),
        eq(settlementInstructions.direction, 'collect'),
        inArray(settlementInstructions.memberId, memberIds),
        excludeCycleId ? ne(settlementInstructions.cycleId, excludeCycleId) : undefined,
      ),
    )
    .groupBy(settlementInstructions.memberId, settlementInstructions.status);
  const tally = (memberId: string, status: string) =>
    rows.find((r) => r.memberId === memberId && r.status === status)?.n ?? 0;
  return memberIds.map((memberId) => ({
    memberId,
    earlierCollectionsConfirmed: tally(memberId, 'confirmed'),
    earlierCollectionsFailed: tally(memberId, 'failed'),
  }));
}
