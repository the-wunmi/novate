import { randomUUID } from 'node:crypto';
import { DBOS } from '@dbos-inc/dbos-sdk';
import {
  type Currency,
  DealTerms,
  DomainError,
  dealAmount,
  dealQuantity,
  Mandate,
} from '@novate/core';
import {
  agents,
  approvals,
  cycles,
  dealEvents,
  dealFacts,
  deals,
  members,
  obligations,
  programs,
  settlementInstructions,
  tenants,
} from '@novate/db';
import { Accounts } from '@novate/ledger';
import { ProgramSpec, type ProgramSpecInput } from '@novate/policy';
import { and, asc, desc, eq, inArray, max, or } from 'drizzle-orm';
import { z } from 'zod';
import { cycleWorkflow } from './cycle-workflow.ts';
import { type ApprovalMessage, Decision, dealWorkflow, Topics } from './deal-workflow.ts';
import { deps, tx } from './deps.ts';
import { getDeal, jsonSafe, record } from './repo.ts';

// ── Tenancy ────────────────────────────────────────────────────────────────

export async function createTenant(input: { name: string }) {
  return tx('createTenant', async (db) => {
    const [row] = await db.insert(tenants).values(input).returning();
    return row as typeof tenants.$inferSelect;
  });
}

export async function createMember(input: {
  tenantId: string;
  name: string;
  homeCurrency: Currency;
  railRefs?: Record<string, string>;
  attributes?: Record<string, unknown>;
}) {
  return tx('createMember', async (db) => {
    const [row] = await db.insert(members).values(input).returning();
    return row as typeof members.$inferSelect;
  });
}

export async function createAgent(input: {
  tenantId: string;
  memberId: string;
  name: string;
  mandate: z.input<typeof Mandate>;
}) {
  const mandate = jsonSafe(Mandate.parse(input.mandate)) as Record<string, unknown>;
  return tx('createAgent', async (db) => {
    const [member] = await db.select().from(members).where(eq(members.id, input.memberId));
    if (!member || member.tenantId !== input.tenantId)
      throw new DomainError('not_found', 'Member not found');
    const [row] = await db
      .insert(agents)
      .values({ ...input, mandate })
      .returning();
    return row as typeof agents.$inferSelect;
  });
}

// ── Programs ───────────────────────────────────────────────────────────────

/** Publish a new immutable version of a program. Deals keep the version they were accepted under. */
export async function publishProgram(input: {
  tenantId: string;
  key: string;
  spec: ProgramSpecInput;
}) {
  const parsed = ProgramSpec.safeParse(input.spec);
  if (!parsed.success) throw new DomainError('invalid', 'Invalid program', parsed.error.issues);
  return tx('publishProgram', async (db) => {
    const [cur] = await db
      .select({ v: max(programs.version) })
      .from(programs)
      .where(and(eq(programs.tenantId, input.tenantId), eq(programs.key, input.key)));
    const [row] = await db
      .insert(programs)
      .values({
        tenantId: input.tenantId,
        key: input.key,
        version: (cur?.v ?? 0) + 1,
        spec: parsed.data as unknown as Record<string, unknown>,
      })
      .returning();
    return row as typeof programs.$inferSelect;
  });
}

export async function latestProgram(db = deps().db, tenantId: string, key: string) {
  const [row] = await db
    .select()
    .from(programs)
    .where(and(eq(programs.tenantId, tenantId), eq(programs.key, key)))
    .orderBy(desc(programs.version))
    .limit(1);
  if (!row) throw new DomainError('not_found', `Program ${key} not found`);
  return row;
}

// ── Funds ──────────────────────────────────────────────────────────────────

/**
 * Record money arriving for a member (a rail webhook in production). Idempotent on `externalRef`.
 * Wakes any of the member's deals that are waiting for funds or margin.
 */
export async function deposit(input: {
  tenantId: string;
  memberId: string;
  currency: Currency;
  amount: bigint;
  rail?: string;
  externalRef: string;
}) {
  const rail = input.rail ?? 'mock';
  const waiting = await tx('deposit', async (db) => {
    await deps().ledger.post(db, input.tenantId, [
      {
        key: `deposit:${rail}:${input.externalRef}`,
        debit: Accounts.houseCash(rail, input.currency),
        credit: Accounts.memberAvailable(input.memberId, input.currency),
        amount: input.amount,
        kind: 'deposit',
        ref: input.externalRef,
      },
    ]);
    const rows = await db
      .select({ id: deals.id })
      .from(deals)
      .where(
        and(
          eq(deals.tenantId, input.tenantId),
          eq(deals.status, 'awaiting_funding'),
          or(eq(deals.buyerMemberId, input.memberId), eq(deals.sellerMemberId, input.memberId)),
        ),
      );
    return rows.map((r) => r.id);
  });
  for (const id of waiting)
    await DBOS.send(
      id,
      { externalRef: input.externalRef },
      Topics.funds,
      `funds:${input.externalRef}:${id}`,
    );
}

export async function balances(tenantId: string, memberId: string) {
  return deps().ledger.balances(deps().db, tenantId, `member:${memberId}:`);
}

// ── Deals ──────────────────────────────────────────────────────────────────

export const SubmitDeal = z.object({
  tenantId: z.string().uuid(),
  idempotencyKey: z.string().min(1),
  programKey: z.string(),
  buyerMemberId: z.string().uuid(),
  sellerMemberId: z.string().uuid(),
  buyerAgentId: z.string().uuid().optional(),
  sellerAgentId: z.string().uuid().optional(),
  terms: DealTerms,
});
export type SubmitDeal = z.input<typeof SubmitDeal>;

/** Accept a deal two agents agreed and start its durable lifecycle. Idempotent per tenant + key. */
export async function submitDeal(input: SubmitDeal) {
  const parsed = SubmitDeal.safeParse(input);
  if (!parsed.success) throw new DomainError('invalid', 'Invalid deal', parsed.error.issues);
  const d = parsed.data;
  if (d.buyerMemberId === d.sellerMemberId)
    throw new DomainError('invalid', 'Buyer and seller must differ');
  const program = await latestProgram(deps().db, d.tenantId, d.programKey);
  const row = await tx('submitDeal', async (db) => {
    const [existing] = await db
      .select()
      .from(deals)
      .where(and(eq(deals.tenantId, d.tenantId), eq(deals.idempotencyKey, d.idempotencyKey)));
    if (existing) return existing;
    const [created] = await db
      .insert(deals)
      .values({
        tenantId: d.tenantId,
        idempotencyKey: d.idempotencyKey,
        programId: program.id,
        buyerMemberId: d.buyerMemberId,
        sellerMemberId: d.sellerMemberId,
        buyerAgentId: d.buyerAgentId,
        sellerAgentId: d.sellerAgentId,
        currency: d.terms.currency,
        amount: dealAmount(d.terms),
        quantity: dealQuantity(d.terms),
        terms: jsonSafe(d.terms) as Record<string, unknown>,
      })
      .returning();
    await record(db, (created as typeof deals.$inferSelect).id, 'submitted', {
      program: `${program.key}@v${program.version}`,
    });
    return created as typeof deals.$inferSelect;
  });
  // The deal id is the workflow id: starting twice is a no-op.
  await DBOS.startWorkflow(dealWorkflow, { workflowID: row.id })(row.id);
  return row;
}

export const SubmitFact = z.object({
  kind: z
    .enum([
      'document',
      'inspection',
      'delivery',
      'acceptance',
      'dispute',
      'dispute_resolved',
      'waiver',
    ])
    .or(z.string()),
  type: z.string(),
  source: z.string(),
  data: z.record(z.string(), z.unknown()),
});

/** Attach evidence to a deal and wake its workflow to re-evaluate release conditions. */
export async function submitFact(dealId: string, input: z.input<typeof SubmitFact>) {
  const f = SubmitFact.parse(input);
  const fact = await tx('submitFact', async (db) => {
    const deal = await getDeal(db, dealId);
    if (['settled', 'cancelled', 'rejected', 'refunded'].includes(deal.status)) {
      throw new DomainError('conflict', `Deal is ${deal.status}`);
    }
    const [row] = await db
      .insert(dealFacts)
      .values({ dealId, ...f })
      .returning();
    await record(db, dealId, 'fact_added', {
      factId: row?.id,
      kind: f.kind,
      type: f.type,
      source: f.source,
    });
    return row as typeof dealFacts.$inferSelect;
  });
  await DBOS.send(dealId, { factId: fact.id }, Topics.fact, `fact:${fact.id}`);
  return fact;
}

/**
 * Decide a pending approval. `bindingHash` must match what the approver was shown, so an approval
 * can never be applied to a deal whose amount, counterparty or evidence changed afterwards.
 */
export async function decideApproval(
  approvalId: string,
  input: { bindingHash: string; decision: Decision; decidedBy: string },
) {
  const decision = Decision.parse(input.decision);
  const approval = await tx('decideApproval', async (db) => {
    const [a] = await db.select().from(approvals).where(eq(approvals.id, approvalId)).for('update');
    if (!a) throw new DomainError('not_found', 'Approval not found');
    if (a.status !== 'pending') throw new DomainError('conflict', `Approval is ${a.status}`);
    if (a.bindingHash !== input.bindingHash)
      throw new DomainError('conflict', 'Approval no longer matches what was shown');
    await db
      .update(approvals)
      .set({
        status: 'decided',
        decision: jsonSafe(decision) as Record<string, unknown>,
        decidedBy: input.decidedBy,
        decidedAt: new Date(),
      })
      .where(eq(approvals.id, approvalId));
    await record(db, a.dealId, 'approval_decided', { approvalId, decision, by: input.decidedBy });
    return a;
  });
  const msg: ApprovalMessage = { approvalId, decision, decidedBy: input.decidedBy };
  await DBOS.send(approval.dealId, msg, Topics.approval, `approval:${approvalId}`);
}

export async function pendingApprovals(tenantId: string) {
  return deps()
    .db.select({ approval: approvals, deal: deals })
    .from(approvals)
    .innerJoin(deals, eq(deals.id, approvals.dealId))
    .where(and(eq(deals.tenantId, tenantId), eq(approvals.status, 'pending')))
    .orderBy(asc(approvals.createdAt));
}

export async function dealDetail(dealId: string) {
  const { db } = deps();
  const deal = await getDeal(db, dealId);
  const [events, facts, appr, obligation] = await Promise.all([
    db
      .select()
      .from(dealEvents)
      .where(eq(dealEvents.dealId, dealId))
      .orderBy(asc(dealEvents.createdAt)),
    db
      .select()
      .from(dealFacts)
      .where(eq(dealFacts.dealId, dealId))
      .orderBy(asc(dealFacts.createdAt)),
    db
      .select()
      .from(approvals)
      .where(eq(approvals.dealId, dealId))
      .orderBy(asc(approvals.createdAt)),
    db.select().from(obligations).where(eq(obligations.dealId, dealId)),
  ]);
  return { deal, events, facts, approvals: appr, obligation: obligation[0] ?? null };
}

export async function listDeals(tenantId: string, limit = 100) {
  return deps()
    .db.select()
    .from(deals)
    .where(eq(deals.tenantId, tenantId))
    .orderBy(desc(deals.createdAt))
    .limit(limit);
}

// ── Cycles ─────────────────────────────────────────────────────────────────

/** Run a clearing cycle now. Returns once the cycle has settled or failed. */
export async function runCycle(tenantId: string, cycleId: string = randomUUID()) {
  const handle = await DBOS.startWorkflow(cycleWorkflow, { workflowID: cycleId })(
    tenantId,
    cycleId,
  );
  return handle.getResult();
}

export async function cycleDetail(cycleId: string) {
  const { db } = deps();
  const [cycle] = await db.select().from(cycles).where(eq(cycles.id, cycleId));
  if (!cycle) throw new DomainError('not_found', 'Cycle not found');
  const instructions = await db
    .select()
    .from(settlementInstructions)
    .where(eq(settlementInstructions.cycleId, cycleId));
  return { cycle, instructions };
}

export async function listMembers(tenantId: string, ids?: string[]) {
  const where = ids
    ? and(eq(members.tenantId, tenantId), inArray(members.id, ids))
    : eq(members.tenantId, tenantId);
  return deps().db.select().from(members).where(where);
}
