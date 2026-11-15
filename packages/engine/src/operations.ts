import { DomainError, type Principal, parseInput } from '@novate/core';
import {
  cycles,
  members,
  reconBreakAssignments,
  reconBreakResolutions,
  reconBreaks,
  settlementInstructions,
  type Tx,
} from '@novate/db';
import { and, desc, eq, inArray, sql } from 'drizzle-orm';
import { z } from 'zod';
import { actorOf, recordControl } from './control.ts';
import { deps, tx } from './deps.ts';
import { Cursor, keyset, newestFirst, pageOf } from './page.ts';
import { recordPaymentStatus } from './rail-events.ts';
import { latestAttempt } from './repo.ts';

// ── Payouts that need someone ──────────────────────────────────────────────

const PageQuery = {
  /** The previous page's `next`. */
  before: Cursor.optional(),
  limit: z.coerce.number().int().min(1).max(200).default(50),
};

const PAYOUT_PROBLEMS = ['in_doubt', 'failed', 'reversed'] as const;

export const PayoutsQuery = z.object({
  /** One of them; without it, all three. */
  status: z.enum(PAYOUT_PROBLEMS).optional(),
  ...PageQuery,
});

const ageSeconds = (since: Date, now: Date) =>
  Math.max(0, Math.floor((now.getTime() - since.getTime()) / 1000));

/**
 * Payouts across every cycle and withdrawal that are in doubt, failed or returned, newest first,
 * each as its latest attempt stands, with who it was for and how long it has waited.
 */
export async function problemPayouts(tenantId: string, input: z.input<typeof PayoutsQuery> = {}) {
  const { status, before, limit } = parseInput(PayoutsQuery, input);
  const rows = await deps()
    .db.select({
      i: settlementInstructions,
      memberName: members.name,
      group: cycles.settlementGroup,
      kind: cycles.kind,
    })
    .from(settlementInstructions)
    .innerJoin(members, eq(members.id, settlementInstructions.memberId))
    .innerJoin(cycles, eq(cycles.id, settlementInstructions.cycleId))
    .where(
      and(
        eq(settlementInstructions.tenantId, tenantId),
        eq(settlementInstructions.direction, 'payout'),
        status
          ? eq(settlementInstructions.status, status)
          : inArray(settlementInstructions.status, [...PAYOUT_PROBLEMS]),
        latestAttempt(deps().db),
        keyset(settlementInstructions.createdAt, settlementInstructions.id, tenantId, before),
      ),
    )
    .orderBy(...newestFirst(settlementInstructions.createdAt, settlementInstructions.id))
    .limit(limit + 1);
  const now = new Date();
  const payouts = rows.map(({ i, memberName, group, kind }) => ({
    id: i.id,
    memberId: i.memberId,
    memberName,
    cycleId: i.cycleId,
    settlementGroup: group,
    withdrawal: kind === 'withdrawal',
    rail: i.rail,
    currency: i.currency,
    amount: i.amount,
    status: i.status,
    attempt: i.attempt,
    externalRef: i.externalRef,
    failureReason: i.failureReason,
    createdAt: i.createdAt,
    updatedAt: i.updatedAt,
    ageSeconds: ageSeconds(i.createdAt, now),
  }));
  return pageOf(payouts, limit, (p) => p.id);
}

export const RefreshPayout = z.object({ reason: z.string().trim().min(1).max(500).optional() });

/**
 * Ask the rail where a payout stands now, rather than waiting for the next poll. A final answer is
 * taken in through the same path as a webhook, so it is handled exactly as one would be; a payment
 * still under way changes nothing. Either way the check is recorded.
 */
export async function refreshPayout(
  tenantId: string,
  principal: Principal,
  instructionId: string,
  input?: z.input<typeof RefreshPayout>,
) {
  const { reason } = parseInput(RefreshPayout, input ?? {});
  parseInput(z.string().uuid(), instructionId);
  const { db, rails } = deps();
  const [ins] = await db
    .select()
    .from(settlementInstructions)
    .where(
      and(
        eq(settlementInstructions.id, instructionId),
        eq(settlementInstructions.tenantId, tenantId),
        eq(settlementInstructions.direction, 'payout'),
      ),
    );
  if (!ins) throw new DomainError('not_found', 'Payout not found');
  if (!ins.externalRef) {
    throw new DomainError(
      'conflict',
      'The rail never gave this payout an id, so there is nothing to ask it about yet',
    );
  }
  // Paid to the wallet, or never sent because the house was short: the rail has nothing to say.
  if (/^(nofunds|wallet):/.test(ins.externalRef)) {
    throw new DomainError('conflict', 'This payout never went to the rail');
  }
  if (!rails.has(ins.rail)) throw new DomainError('conflict', `Rail ${ins.rail} is not running`);
  const found = await rails.get(ins.rail).status(ins.externalRef, 'payout');
  const final = found.status === 'confirmed' || found.status === 'failed';
  const applied = final
    ? await recordPaymentStatus(
        ins.rail,
        ins.externalRef,
        found.status as 'confirmed' | 'failed',
        found.reason,
      )
    : null;
  await tx('payout_refreshed', (t) =>
    recordControl(t, tenantId, actorOf(principal), {
      type: 'payout_refreshed',
      reason,
      payload: {
        instructionId: ins.id,
        cycleId: ins.cycleId,
        memberId: ins.memberId,
        rail: ins.rail,
        externalRef: ins.externalRef,
        was: ins.status,
        found: found.status,
        ...(found.reason ? { railReason: found.reason } : {}),
      },
    }),
  );
  return {
    id: ins.id,
    externalRef: ins.externalRef,
    /** The status novate had before asking. */
    was: ins.status,
    /** What the rail says now. */
    status: found.status,
    reason: found.reason ?? null,
    /** Whether the answer was taken in now: false when the same answer had been taken in before. */
    applied: applied ? !applied.duplicate : false,
  };
}

// ── Withdrawals across members ─────────────────────────────────────────────

export const TenantWithdrawalsQuery = z.object({
  memberId: z.string().uuid().optional(),
  status: z
    .enum(['pending', 'submitted', 'confirmed', 'failed', 'reversed', 'in_doubt'])
    .optional(),
  ...PageQuery,
});

/** Every member's withdrawals, newest first, each as its latest payment attempt stands. */
export async function tenantWithdrawals(
  tenantId: string,
  input: z.input<typeof TenantWithdrawalsQuery> = {},
) {
  const { memberId, status, before, limit } = parseInput(TenantWithdrawalsQuery, input);
  const { db } = deps();
  const rows = await db
    .select({ i: settlementInstructions, memberName: members.name, at: cycles.createdAt })
    .from(settlementInstructions)
    .innerJoin(cycles, eq(cycles.id, settlementInstructions.cycleId))
    .innerJoin(members, eq(members.id, settlementInstructions.memberId))
    .where(
      and(
        eq(settlementInstructions.tenantId, tenantId),
        eq(cycles.kind, 'withdrawal'),
        latestAttempt(deps().db),
        memberId ? eq(settlementInstructions.memberId, memberId) : undefined,
        status ? eq(settlementInstructions.status, status) : undefined,
        keyset(cycles.createdAt, cycles.id, tenantId, before),
      ),
    )
    .orderBy(...newestFirst(cycles.createdAt, cycles.id))
    .limit(limit + 1);
  const now = new Date();
  const withdrawals = rows.map(({ i, memberName, at }) => ({
    id: i.cycleId,
    memberId: i.memberId,
    memberName,
    at,
    ageSeconds: ageSeconds(at, now),
    currency: i.currency,
    amount: i.amount,
    rail: i.rail,
    status: i.status,
    attempt: i.attempt,
    instructionId: i.id,
    externalRef: i.externalRef,
    failureReason: i.failureReason,
    returnedToWallet: i.returnedToWalletAt !== null,
  }));
  return pageOf(withdrawals, limit, (w) => w.id);
}

// ── Who owns a reconciliation break ────────────────────────────────────────

/** The latest assignment of each break: who holds it now, or null if it was let go. */
export async function breakAssignees(db: Tx, breakIds: string[]) {
  if (!breakIds.length) return new Map<string, typeof reconBreakAssignments.$inferSelect>();
  const rows = await db
    .select()
    .from(reconBreakAssignments)
    .where(inArray(reconBreakAssignments.breakId, breakIds))
    .orderBy(desc(reconBreakAssignments.createdAt), desc(reconBreakAssignments.id));
  const latest = new Map<string, typeof reconBreakAssignments.$inferSelect>();
  for (const r of rows) if (!latest.has(r.breakId)) latest.set(r.breakId, r);
  return latest;
}

/**
 * Take an open break, or let it go, so two people do not chase the same difference. It only says
 * who is on it: anyone allowed to resolve the break still can. Each change is a new row.
 */
export async function setBreakAssignee(
  tenantId: string,
  principal: Principal,
  breakId: string,
  assigned: boolean,
) {
  parseInput(z.string().uuid(), breakId);
  return tx('assign_break', async (db) => {
    const [row] = await db
      .select({ id: reconBreaks.id, resolved: reconBreakResolutions.id })
      .from(reconBreaks)
      .leftJoin(reconBreakResolutions, eq(reconBreakResolutions.breakId, reconBreaks.id))
      .where(and(eq(reconBreaks.id, breakId), eq(reconBreaks.tenantId, tenantId)));
    if (!row) throw new DomainError('not_found', 'Break not found');
    if (row.resolved) throw new DomainError('conflict', 'This break is already resolved');
    // Serialise changes to one break, so the latest row is the latest decision.
    await db.execute(sql`select pg_advisory_xact_lock(hashtext(${`break:${breakId}`}))`);
    const actor = actorOf(principal);
    const assignee = assigned ? actor : null;
    const [saved] = await db
      .insert(reconBreakAssignments)
      .values({ breakId, tenantId, assignee, actor })
      .returning();
    await recordControl(db, tenantId, actor, {
      type: assigned ? 'break_assigned' : 'break_unassigned',
      payload: { breakId },
    });
    return { assignee, assignedAt: assigned ? (saved?.createdAt ?? null) : null };
  });
}
