import { absBig, type ControlActor, DomainError, type Principal, parseInput } from '@novate/core';
import {
  controlEvents,
  decisionCases,
  ledgerTransfers,
  reconBreakResolutions,
  reconBreaks,
  reconRuns,
  type Tx,
  tenants,
} from '@novate/db';
import { railLabel } from '@novate/rails';
import { and, asc, eq, isNull, sql } from 'drizzle-orm';
import { z } from 'zod';
import { actorOf, personOf, Reason, ReasonInput, recordControl } from './control.ts';
import { tx } from './deps.ts';
import {
  APPROVAL_TTL_MS,
  type PendingApproval,
  registerApprovalExecutor,
  requestApproval,
} from './four-eyes.ts';
import { newerThan, newestFirst } from './page.ts';
import { countedBreaks, openingOf, shownMoney } from './reconciliation.ts';
import { needsFourEyes, tenantSettings } from './settings.ts';

/**
 * Let settlement run again. Refused while any rail still has a difference nobody has closed, or a
 * reconciliation case is waiting for a person, because those are what stopped it.
 */
export async function resumeSettlement(
  tenantId: string,
  principal: Principal,
  input: z.input<typeof ReasonInput>,
): Promise<void> {
  const { reason } = parseInput(ReasonInput, input);
  personOf(principal, 'resume settlement');
  await tx('resume_settlement', async (db) => {
    const blockers = await resumeBlockers(db, tenantId);
    if (blockers.length) {
      throw new DomainError('conflict', `Settlement cannot resume: ${blockers.join('; ')}`, {
        blockers,
      });
    }
    await resumeIfClear(db, tenantId, actorOf(principal), { reason });
  });
}

/** Lift the stop, recording who and why. Does nothing when settlement is not stopped. */
export async function resumeIfClear(
  db: Tx,
  tenantId: string,
  actor: ControlActor,
  why: { reason: string; caseId?: string },
) {
  const [before] = await db
    .select({ haltedAt: tenants.settlementHaltedAt, reason: tenants.settlementHaltReason })
    .from(tenants)
    .where(eq(tenants.id, tenantId))
    .for('update');
  if (!before?.haltedAt || (await resumeBlockers(db, tenantId)).length) return;
  await db
    .update(tenants)
    .set({ settlementHaltedAt: null, settlementHaltReason: null })
    .where(eq(tenants.id, tenantId));
  await recordControl(db, tenantId, actor, {
    type: 'settlement_resumed',
    reason: why.reason,
    payload: { stoppedBecause: before.reason, ...(why.caseId ? { caseId: why.caseId } : {}) },
  });
}

/** Why settlement may not resume yet, in words a person can act on. */
async function resumeBlockers(db: Tx, tenantId: string): Promise<string[]> {
  const open = countedBreaks(await openBreakRows(db, tenantId));
  const byRail = Map.groupBy(open, (b) => b.rail);
  const cases = await db
    .select({ id: decisionCases.id, rail: reconRuns.rail })
    .from(decisionCases)
    .innerJoin(reconRuns, eq(sql`${reconRuns.id}::text`, decisionCases.subjectId))
    .where(
      and(
        eq(decisionCases.tenantId, tenantId),
        eq(decisionCases.kind, 'recon_break'),
        eq(decisionCases.status, 'open'),
      ),
    );
  return [
    ...[...byRail].map(
      ([rail, rows]) =>
        `${rows.length} unresolved ${rows.length === 1 ? 'break' : 'breaks'} on ${railLabel(rail)}`,
    ),
    ...cases.map((c) => `case ${c.id} about ${railLabel(c.rail)} is waiting for a person`),
  ];
}

/** Every stop since settlement last resumed came from reconciliation, not from a person. */
export async function stoppedOnlyByReconciliation(db: Tx, tenantId: string): Promise<boolean> {
  const [resumed] = await db
    .select({ id: controlEvents.id })
    .from(controlEvents)
    .where(and(eq(controlEvents.tenantId, tenantId), eq(controlEvents.type, 'settlement_resumed')))
    .orderBy(...newestFirst(controlEvents.createdAt, controlEvents.id))
    .limit(1);
  const stops = await db
    .select({ actor: controlEvents.actor, payload: controlEvents.payload })
    .from(controlEvents)
    .where(
      and(
        eq(controlEvents.tenantId, tenantId),
        eq(controlEvents.type, 'settlement_stopped'),
        ...(resumed
          ? [newerThan(controlEvents.createdAt, controlEvents.id, tenantId, resumed.id)]
          : []),
      ),
    );
  return stops.every((e) => e.actor.kind === 'system' && typeof e.payload.rail === 'string');
}

type BreakRow = typeof reconBreaks.$inferSelect & { rail: string };

/** Breaks nobody has closed, oldest first, on one rail or all of them. */
export async function openBreakRows(db: Tx, tenantId: string, rail?: string): Promise<BreakRow[]> {
  const rows = await db
    .select({ b: reconBreaks, rail: reconRuns.rail })
    .from(reconBreaks)
    .innerJoin(reconRuns, eq(reconRuns.id, reconBreaks.runId))
    .leftJoin(reconBreakResolutions, eq(reconBreakResolutions.breakId, reconBreaks.id))
    .where(
      and(
        eq(reconBreaks.tenantId, tenantId),
        isNull(reconBreakResolutions.id),
        ...(rail ? [eq(reconRuns.rail, rail)] : []),
      ),
    )
    .orderBy(asc(reconBreaks.createdAt), asc(reconBreaks.id));
  return rows.map((r) => ({ ...r.b, rail: r.rail }));
}

/**
 * Why money may not move on this rail yet, or null. A break nobody has closed means the books and
 * the rail disagree, so nothing settles on that rail until a person has closed every one.
 */
export async function railBreakHold(db: Tx, tenantId: string, rail: string) {
  const open = countedBreaks(await openBreakRows(db, tenantId, rail));
  if (!open.length) return null;
  const n = open.length;
  return `${n} unresolved reconciliation ${n === 1 ? 'break' : 'breaks'} on ${railLabel(rail)}: nothing settles on it until ${n === 1 ? 'it is' : 'they are'} resolved`;
}

/** Every rail `railBreakHold` holds, with how many differences are open and since when. */
export async function heldRails(db: Tx, tenantId: string) {
  const held = new Map<string, { rail: string; openDifferences: number; since: Date }>();
  for (const b of countedBreaks(await openBreakRows(db, tenantId))) {
    const found = held.get(b.rail);
    if (found) found.openDifferences++;
    else held.set(b.rail, { rail: b.rail, openDifferences: 1, since: b.createdAt });
  }
  return [...held.values()];
}

/** The same difference seen again by a later run is one difference, so it closes with the first. */
const sameDifference = (b: typeof reconBreaks.$inferSelect) =>
  [b.kind, b.currency, b.externalRef ?? '', b.expected, b.actual].join('|');

type BreakResolution = Omit<typeof reconBreakResolutions.$inferInsert, 'breakId' | 'tenantId'>;

/** Close every open break on the rail that is the same difference as one of these. */
export async function closeMatchingBreaks(
  db: Tx,
  tenantId: string,
  rail: string,
  targets: (typeof reconBreaks.$inferSelect)[],
  resolution: BreakResolution,
): Promise<string[]> {
  const wanted = new Set(targets.map(sameDifference));
  const hit = (await openBreakRows(db, tenantId, rail)).filter((b) =>
    wanted.has(sameDifference(b)),
  );
  if (hit.length) {
    await db
      .insert(reconBreakResolutions)
      .values(hit.map((b) => ({ ...resolution, breakId: b.id, tenantId })))
      .onConflictDoNothing();
  }
  return hit.map((b) => b.id);
}

export const ResolveBreak = z
  .object({
    resolution: z.enum(['posted', 'explained', 'written_off']),
    reason: Reason,
    /**
     * What closes it: a document or a ticket. For `posted`, the id of the ledger transfer that
     * corrects it, in the break's currency and for exactly its difference.
     */
    reference: z.string().trim().min(1).max(200).optional(),
  })
  .refine((r) => r.resolution !== 'posted' || r.reference, {
    message: 'A posted correction needs the reference of what was posted',
  });

/**
 * A person closes a difference: a correcting entry was posted, it is explained, or it is written
 * off. The same difference found again by later runs closes with it. A posted correction must name
 * a real ledger transfer that matches the difference, and is refused once a later opening has
 * already absorbed it, because posting it then would count the money twice.
 */
export async function resolveBreak(
  tenantId: string,
  principal: Principal,
  breakId: string,
  input: z.input<typeof ResolveBreak>,
): Promise<{ resolved: string[] } | PendingApproval> {
  const parsed = parseInput(ResolveBreak, input);
  parseInput(z.string().uuid(), breakId);
  personOf(principal, 'resolve a break');
  return tx('resolve_break', async (db) => {
    const found = await lockOpenBreak(db, tenantId, breakId);
    // Writing a difference off hides money, so above the threshold a second person approves it.
    if (parsed.resolution === 'written_off') {
      const amount = absBig(found.b.actual - found.b.expected);
      if (needsFourEyes(await tenantSettings(db, tenantId), found.b.currency, amount)) {
        return requestApproval(db, tenantId, principal, {
          kind: 'break_write_off',
          payload: { breakId, ...parsed },
          amount,
          currency: found.b.currency,
          reason: parsed.reason,
        });
      }
    }
    return closeBreak(db, tenantId, actorOf(principal), found, parsed);
  });
}

async function lockOpenBreak(db: Tx, tenantId: string, breakId: string) {
  const [found] = await db
    .select({
      b: reconBreaks,
      rail: reconRuns.rail,
      runAt: reconRuns.createdAt,
      resolved: reconBreakResolutions.id,
    })
    .from(reconBreaks)
    .innerJoin(reconRuns, eq(reconRuns.id, reconBreaks.runId))
    .leftJoin(reconBreakResolutions, eq(reconBreakResolutions.breakId, reconBreaks.id))
    .where(and(eq(reconBreaks.id, breakId), eq(reconBreaks.tenantId, tenantId)))
    .for('update', { of: reconBreaks });
  if (!found) throw new DomainError('not_found', 'Break not found');
  if (found.resolved) throw new DomainError('conflict', 'Break is already resolved');
  return found;
}

async function closeBreak(
  db: Tx,
  tenantId: string,
  actor: ControlActor,
  found: Awaited<ReturnType<typeof lockOpenBreak>>,
  { resolution, reason, reference }: z.output<typeof ResolveBreak>,
  approval?: { approvalId: string; approvedBy: ControlActor },
) {
  if (resolution === 'posted') {
    await assertPostedCorrection(db, tenantId, found.b, found.rail, found.runAt, reference ?? '');
  }
  const resolved = await closeMatchingBreaks(db, tenantId, found.rail, [found.b], {
    resolution,
    actor,
    reason,
    reference: reference ?? (approval ? `approval:${approval.approvalId}` : null),
  });
  await recordControl(db, tenantId, actor, {
    type: 'break_resolved',
    reason,
    payload: {
      rail: found.rail,
      resolution,
      reference: reference ?? null,
      breakIds: resolved,
      ...approval,
    },
  });
  return { resolved };
}

registerApprovalExecutor('break_write_off', {
  approvers: ['house'],
  ttlMs: APPROVAL_TTL_MS,
  async run(db, request, approvedBy) {
    const { breakId, ...rest } = request.payload as { breakId: string };
    const found = await lockOpenBreak(db, request.tenantId, breakId);
    return closeBreak(db, request.tenantId, request.actor, found, parseInput(ResolveBreak, rest), {
      approvalId: request.id,
      approvedBy,
    });
  },
});

/** A posted correction names a ledger transfer of this tenant that is exactly the difference. */
async function assertPostedCorrection(
  db: Tx,
  tenantId: string,
  b: typeof reconBreaks.$inferSelect,
  rail: string,
  runAt: Date,
  reference: string,
) {
  const opening = await openingOf(db, tenantId, rail);
  if (opening && opening.createdAt > runAt) {
    throw new DomainError(
      'conflict',
      `A later opening of ${railLabel(rail)} already absorbed this difference, so a posted correction would count it twice: resolve it as explained, or rebase`,
      { openingAt: opening.createdAt },
    );
  }
  const difference = absBig(b.actual - b.expected);
  const wrong = (why: string) =>
    new DomainError(
      'invalid',
      `The reference must be the id of the ledger transfer that corrects this break: ${why}`,
      {
        reference,
        currency: b.currency,
        difference,
      },
    );
  if (!z.string().uuid().safeParse(reference).success) throw wrong('not a transfer id');
  const [transfer] = await db
    .select({ currency: ledgerTransfers.currency, amount: ledgerTransfers.amount })
    .from(ledgerTransfers)
    .where(and(eq(ledgerTransfers.id, reference), eq(ledgerTransfers.tenantId, tenantId)));
  if (!transfer) throw wrong('no such transfer');
  if (transfer.currency !== b.currency) {
    throw wrong(`it is in ${transfer.currency}, the break in ${b.currency}`);
  }
  if (transfer.amount !== difference) {
    throw wrong(
      `it moved ${shownMoney(transfer.amount, transfer.currency)}, the difference is ${shownMoney(difference, b.currency)}`,
    );
  }
  const [used] = await db
    .select({ id: reconBreakResolutions.id })
    .from(reconBreakResolutions)
    .where(
      and(
        eq(reconBreakResolutions.tenantId, tenantId),
        eq(reconBreakResolutions.resolution, 'posted'),
        eq(reconBreakResolutions.reference, reference),
      ),
    )
    .limit(1);
  if (used) throw new DomainError('conflict', 'That transfer already closed another difference');
}
