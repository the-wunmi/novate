import { type DealStatus, DomainError } from '@novate/core';
import { agents, dealEvents, dealFacts, deals, members, programs, type Tx } from '@novate/db';
import type { Fact } from '@novate/policy';
import { asc, eq } from 'drizzle-orm';

export type DealRow = typeof deals.$inferSelect;
export type MemberRow = typeof members.$inferSelect;
export type AgentRow = typeof agents.$inferSelect;

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

export async function getProgram(db: Tx, programId: string) {
  const [row] = await db.select().from(programs).where(eq(programs.id, programId));
  if (!row) throw new DomainError('not_found', `Program ${programId} not found`);
  return row;
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
  await db.insert(dealEvents).values({ dealId, type, payload: jsonSafe(payload) });
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

/** JSONB cannot hold bigint; store amounts as strings of minor units. */
export function jsonSafe<T>(value: T): T {
  return JSON.parse(
    JSON.stringify(value, (_k, v) => (typeof v === 'bigint' ? v.toString() : v)),
  ) as T;
}
