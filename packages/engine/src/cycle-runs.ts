import { randomUUID } from 'node:crypto';
import { DBOS } from '@dbos-inc/dbos-sdk';
import { Currency, DomainError, MinorAmount, type Principal, parseInput } from '@novate/core';
import {
  approvalDecisions,
  approvalRequests,
  controlEvents,
  cycles,
  ledgerAccounts,
  ledgerTransfers,
  obligations,
  settlementInstructions,
  type Tx,
} from '@novate/db';
import { and, eq, inArray, lt, sql } from 'drizzle-orm';
import { z } from 'zod';
import { actorOf } from './control.ts';
import { cycleViews, paidAtOf } from './cycle-views.ts';
import {
  type CycleSummary,
  cycleWorkflow,
  WITHDRAWAL_OPENED,
  type WithdrawalOpened,
  type WithdrawalRequest,
  withdrawalRefusal,
  withdrawalWorkflow,
} from './cycle-workflow.ts';
import { railRefusal } from './deal-policy.ts';
import { deps, tx } from './deps.ts';
import {
  APPROVAL_TTL_MS,
  type PendingApproval,
  pendingOf,
  registerApprovalExecutor,
  requestApproval,
  requestStatus,
} from './four-eyes.ts';
import { defaultWithdrawalRail } from './member-account.ts';
import { HOUSE_FX_IN, HOUSE_FX_OUT, memberFxExchanges } from './member-fx.ts';
import { inTenant, memberInTenant } from './repo.ts';
import { stableUuid } from './settlement-group.ts';

const startGroupCycle = (tenantId: string, group: string) => {
  const cycleId = randomUUID();
  return DBOS.startWorkflow(cycleWorkflow, { workflowID: cycleId })(tenantId, cycleId, group);
};

/** Start settling everything eligible, one cycle per group, without waiting for it to finish. */
export async function startCycles(tenantId: string): Promise<string[]> {
  const handles = await Promise.all(
    (await eligibleGroups(deps().db, tenantId)).map((group) => startGroupCycle(tenantId, group)),
  );
  return handles.map((h) => h.workflowID);
}

/** Settle everything eligible now and wait for the merged result. */
export async function runCycle(tenantId: string): Promise<CycleSummary> {
  const results: CycleSummary[] = [];
  for (const group of await eligibleGroups(deps().db, tenantId)) {
    const handle = await startGroupCycle(tenantId, group);
    results.push(await handle.getResult());
  }
  return mergeSummaries(results);
}

export async function eligibleGroups(db: Tx, tenantId: string): Promise<string[]> {
  const rows = await db
    .selectDistinct({ group: obligations.settlementGroup })
    .from(obligations)
    .where(and(eq(obligations.tenantId, tenantId), eq(obligations.status, 'eligible')));
  return rows.flatMap((r) => (r.group ? [r.group] : []));
}

function mergeSummaries(results: CycleSummary[]): CycleSummary {
  const worst = (['halted', 'failed', 'deferred'] as const).find((s) =>
    results.some((r) => r.status === s),
  );
  return {
    cycleId: results[0]?.cycleId ?? '',
    status: worst ?? (results.some((r) => r.status === 'settled') ? 'settled' : 'empty'),
    obligations: results.reduce((acc, r) => acc + r.obligations, 0),
    totals: Object.assign({}, ...results.map((r) => r.totals)),
    failures: results.flatMap((r) => r.failures),
    fx: results.find((r) => r.fx)?.fx,
    ...(results.find((r) => r.reason) ? { reason: results.find((r) => r.reason)?.reason } : {}),
  };
}

export async function cycleDetail(tenantId: string, cycleId: string) {
  const { db } = deps();
  const [found] = await db.select().from(cycles).where(eq(cycles.id, cycleId));
  const row = inTenant(found, tenantId, 'Cycle');
  const [[cycle], instructions, fx] = await Promise.all([
    cycleViews(db, [row]),
    db.select().from(settlementInstructions).where(eq(settlementInstructions.cycleId, cycleId)),
    cycleFx(db as unknown as Tx, row),
  ]);
  const view = cycle as NonNullable<typeof cycle>;
  const paidAt = await paidAtOf(
    db,
    instructions.map((i) => i.id),
  );
  return {
    cycle: view,
    // `failureReason` is on each row; `paidAt` is when the rail confirmed it, not `updatedAt`.
    instructions: instructions.map((i) => ({ ...i, paidAt: paidAt.get(i.id) ?? null })),
    positions: grossPositions(view.owed),
    ...fx,
  };
}

/**
 * Each member's exchange in a cycle, as its ledger batch records it, and what the house kept in each
 * currency once everything into and out of its FX position in the cycle is set against each other.
 * Members sell at amounts rounded up and the rail rounds its own way, so a few minor units can stay
 * with the house: that is `rounding`, positive when the house kept money. Until the cycle has
 * settled, what the house holds is a conversion still under way or one a stopped cycle left behind,
 * so it is `openFx` instead.
 */
async function cycleFx(db: Tx, cycle: typeof cycles.$inferSelect) {
  const { tenantId, id: cycleId } = cycle;
  const legs = await db
    .select({
      batchId: ledgerTransfers.batchId,
      kind: ledgerTransfers.kind,
      currency: ledgerTransfers.currency,
      amount: ledgerTransfers.amount,
      creditMember: ledgerAccounts.memberId,
    })
    .from(ledgerTransfers)
    .innerJoin(ledgerAccounts, eq(ledgerAccounts.id, ledgerTransfers.creditAccountId))
    .where(
      and(
        eq(ledgerTransfers.tenantId, tenantId),
        eq(ledgerTransfers.ref, cycleId),
        inArray(ledgerTransfers.kind, [...HOUSE_FX_IN, ...HOUSE_FX_OUT]),
      ),
    );
  const buyer = new Map(
    legs.flatMap((l) =>
      l.kind === 'fx_member_buy' && l.creditMember ? [[l.batchId, l.creditMember]] : [],
    ),
  );
  const exchanges = memberFxExchanges(legs).map((e) => ({
    memberId: buyer.get(e.batchId) as string,
    sellCurrency: e.sellCurrency,
    sold: e.sold,
    buyCurrency: e.buyCurrency,
    bought: e.bought,
  }));
  const into = new Set<string>(HOUSE_FX_IN);
  const kept = new Map<string, bigint>();
  for (const l of legs) {
    kept.set(l.currency, (kept.get(l.currency) ?? 0n) + (into.has(l.kind) ? l.amount : -l.amount));
  }
  const held = [...kept].flatMap(([currency, amount]) =>
    amount === 0n ? [] : [{ currency, amount }],
  );
  const settled = cycle.status === 'settled';
  return { exchanges, rounding: settled ? held : [], openFx: settled ? [] : held };
}

/** What each member owes and is owed in each currency of a cycle. Positive net means it receives. */
function grossPositions(
  owed: { payer: string; payee: string; amount: bigint; currency: string }[],
) {
  const byKey = new Map<
    string,
    { memberId: string; currency: string; owes: bigint; owed: bigint }
  >();
  const at = (memberId: string, currency: string) => {
    const key = `${memberId}:${currency}`;
    const found = byKey.get(key) ?? { memberId, currency, owes: 0n, owed: 0n };
    byKey.set(key, found);
    return found;
  };
  for (const o of owed) {
    at(o.payer, o.currency).owes += o.amount;
    at(o.payee, o.currency).owed += o.amount;
  }
  return [...byKey.values()].map((p) => ({ ...p, net: p.owed - p.owes }));
}

export const Withdraw = z.object({
  currency: Currency,
  amount: MinorAmount.refine((v) => v > 0n, { message: 'Amount must be positive' }),
  /** Defaults to the rail of the member's payout account. */
  rail: z.string().min(1).optional(),
  /** Same key, same withdrawal: a retry cannot send the money twice. */
  idempotencyKey: z.string().min(1),
  /** Kept with the request when the member's own four eyes holds it. */
  reason: z.string().trim().min(1).max(500).optional(),
});

/** What a member's four eyes holds: the withdrawal as asked, run once a second user approves. */
const WithdrawalAsked = z.object({
  withdrawalId: z.string().uuid(),
  memberId: z.string().uuid(),
  currency: Currency,
  amount: MinorAmount,
  rail: z.string().min(1),
});

/**
 * Send a member's free balance to the payout destination the house has on record for it. When one
 * of the member's own people asks for more than the member's `withdrawalFourEyesAbove` in that
 * currency, it waits for a second user of the member. The request takes the withdrawal's id, so
 * asking again with the same key finds it: still waiting, sent once approved, refused once rejected
 * or expired.
 */
export async function requestWithdrawal(
  tenantId: string,
  principal: Principal,
  memberId: string,
  input: z.input<typeof Withdraw>,
): Promise<{ id: string } | PendingApproval> {
  const { rail: named, idempotencyKey, reason, ...request } = parseInput(Withdraw, input);
  const rail = named ?? (await defaultWithdrawalRail(tenantId, memberId));
  const refusal = railRefusal(tenantId, rail);
  if (refusal) throw new DomainError('invalid', refusal);
  const member = await tx('withdrawal_member', (db) => memberInTenant(db, tenantId, memberId));
  const id = stableUuid(`withdrawal:${tenantId}:${memberId}:${idempotencyKey}`);
  const above = member.withdrawalFourEyesAbove[request.currency];
  if (principal.kind === 'member' && above !== undefined && request.amount > BigInt(above)) {
    const held = await tx('withdrawal_held', async (db) => {
      const [asked] = await db
        .select()
        .from(approvalRequests)
        .where(
          and(
            eq(approvalRequests.id, id),
            eq(approvalRequests.tenantId, tenantId),
            eq(approvalRequests.kind, 'member_withdrawal'),
          ),
        );
      if (asked) {
        const status = await requestStatus(db, asked);
        if (status === 'pending') return pendingOf(asked);
        if (status === 'approved') return asked;
        throw new DomainError('conflict', `This withdrawal was ${status}: ask again`);
      }
      const refused = await withdrawalRefusal(db, tenantId, rail, { ...request, memberId });
      if (refused) throw new DomainError(refused.code, refused.message);
      return requestApproval(db, tenantId, principal, {
        id,
        kind: 'member_withdrawal',
        memberId,
        payload: { withdrawalId: id, memberId, rail, ...request },
        amount: request.amount,
        currency: request.currency,
        reason: reason ?? 'Withdrawal to the payout account on record',
      });
    });
    if ('status' in held) return held;
    await startWithdrawal(approvedWithdrawal(held));
    return { id };
  }
  await startWithdrawal({
    tenantId,
    id,
    rail,
    request: { ...request, memberId, requestedBy: actorOf(principal) },
  });
  return { id };
}

interface WithdrawalStart {
  tenantId: string;
  id: string;
  rail: string;
  request: WithdrawalRequest;
}

/** The withdrawal an approved request asked for, sent as the person who asked. */
function approvedWithdrawal(r: typeof approvalRequests.$inferSelect): WithdrawalStart {
  const { withdrawalId, rail, ...asked } = parseInput(WithdrawalAsked, r.payload);
  return {
    tenantId: r.tenantId,
    id: withdrawalId,
    rail,
    request: { ...asked, requestedBy: r.actor },
  };
}

/** Starting a withdrawal that has started already does nothing: its id is the workflow's. */
const launchWithdrawal = ({ tenantId, id, rail, request }: WithdrawalStart) =>
  DBOS.startWorkflow(withdrawalWorkflow, { workflowID: id })(tenantId, id, rail, request);

async function startWithdrawal(start: WithdrawalStart) {
  await launchWithdrawal(start);
  const opened = await DBOS.getEvent<WithdrawalOpened>(start.id, WITHDRAWAL_OPENED, 30);
  if (opened?.refusal) throw new DomainError(opened.refusal.code, opened.refusal.message);
}

/**
 * A second user of the member approves a held withdrawal. Everything that would refuse it is
 * checked in the approval's transaction, so a refusal leaves the request open; it is then sent as
 * the person who asked for it.
 */
registerApprovalExecutor('member_withdrawal', {
  approvers: ['member'],
  ttlMs: APPROVAL_TTL_MS,
  async run(db, request) {
    const start = approvedWithdrawal(request);
    const unknownRail = railRefusal(start.tenantId, start.rail);
    if (unknownRail) throw new DomainError('invalid', unknownRail);
    await memberInTenant(db, start.tenantId, start.request.memberId);
    const refused = await withdrawalRefusal(db, start.tenantId, start.rail, start.request);
    if (refused) throw new DomainError(refused.code, refused.message);
    return start;
  },
  after: startWithdrawal,
});

/**
 * An approval commits before its withdrawal is started, so a crash in between would leave it
 * approved with nothing sent. Any approved withdrawal that never opened or was refused is started.
 */
export async function startApprovedWithdrawals(tenantId: string, olderThanMs: number) {
  const stranded = await tx('withdrawals_stranded', (db) =>
    db
      .select({ r: approvalRequests })
      .from(approvalRequests)
      .innerJoin(approvalDecisions, eq(approvalDecisions.requestId, approvalRequests.id))
      .where(
        and(
          eq(approvalRequests.tenantId, tenantId),
          eq(approvalRequests.kind, 'member_withdrawal'),
          eq(approvalDecisions.decision, 'approved'),
          lt(approvalDecisions.createdAt, new Date(Date.now() - olderThanMs)),
          sql`not exists (select 1 from ${controlEvents} where ${controlEvents.tenantId} = ${tenantId} and ${controlEvents.type} = 'withdrawal_requested' and ${controlEvents.payload}->>'withdrawalId' = ${approvalRequests.id}::text)`,
        ),
      ),
  );
  for (const { r } of stranded) await launchWithdrawal(approvedWithdrawal(r));
  return stranded.length;
}

export async function withdrawalDetail(tenantId: string, memberId: string, id: string) {
  const rows = await deps()
    .db.select()
    .from(settlementInstructions)
    .where(
      and(
        eq(settlementInstructions.tenantId, tenantId),
        eq(settlementInstructions.memberId, memberId),
        eq(settlementInstructions.cycleId, id),
      ),
    );
  if (!rows.length) throw new DomainError('not_found', 'Withdrawal not found');
  return rows;
}
