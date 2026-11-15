import { type DealStatus, DomainError } from '@novate/core';
import {
  agents,
  dealEvents,
  dealFacts,
  deals,
  members,
  programs,
  settlementInstructions,
  type Tx,
  tenants,
} from '@novate/db';
import { type Fact, ProgramSpec, type ResolvedPolicy } from '@novate/policy';
import type { SignalReading } from '@novate/signals';
import { and, asc, count, eq, inArray, ne } from 'drizzle-orm';

export type DealRow = typeof deals.$inferSelect;
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

/** Membership of the tenant is the access check, and a miss reads the same as not existing. */
export async function memberInTenant(db: Tx, tenantId: string, memberId: string) {
  const member = await getMember(db, memberId);
  if (member.tenantId !== tenantId) throw new DomainError('not_found', 'Member not found');
  return member;
}

/** Stop new settlement for a tenant until someone with a house key resumes it. */
export async function haltSettlement(db: Tx, tenantId: string, reason: string): Promise<void> {
  await db
    .update(tenants)
    .set({ settlementHaltedAt: new Date(), settlementHaltReason: reason })
    .where(eq(tenants.id, tenantId));
}

export async function setStatus(
  db: Tx,
  dealId: string,
  status: DealStatus,
  event: { type: string; payload?: Record<string, unknown> },
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
  type: string,
  payload: Record<string, unknown> = {},
): Promise<void> {
  await db.insert(dealEvents).values({ dealId, type, payload: payload });
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
