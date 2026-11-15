import { type ControlActor, DomainError, type Principal, parseInput } from '@novate/core';
import { approvalDecisions, approvalRequests, controlEvents, type Tx } from '@novate/db';
import { and, eq, gt, inArray, isNull, not, or, sql } from 'drizzle-orm';
import { z } from 'zod';
import { actorOf, personOf, ReasonInput, recordControl } from './control.ts';
import { deps, tx } from './deps.ts';
import { newestFirst, pageOf } from './page.ts';
import { type PopulationInput, populationOf, type Window, within } from './population.ts';

/**
 * Four eyes. An action that moves or hides money past a tenant's threshold is held as a request
 * until a second signed-in person approves it; it then runs exactly once, in the approval's own
 * transaction. The person who asked can never approve, and nor can anyone the requester brought in
 * (or who brought the requester in) within the last 30 days, so nobody can invite a second
 * "person" to their own address and approve themselves. A member's own request (`memberId` set)
 * is decided only by another user of that member; the house and platform decide the rest.
 */

export type ApprovalKind = (typeof approvalRequests.$inferInsert)['kind'];
type RequestRow = typeof approvalRequests.$inferSelect;

/** How long most held actions wait for a second person before they must be asked again. */
export const APPROVAL_TTL_MS = 72 * 3_600_000;
/** Inviting or resetting someone this recently ties the two people together. */
export const RELATION_WINDOW_MS = 30 * 86_400_000;

export interface ApprovalExecutor<R, P = undefined> {
  /** Who may approve this kind, beyond being a second person. */
  approvers: Principal['kind'][];
  /** How long a request stays open: past this it must be made again. */
  ttlMs: number;
  /** What must be read from outside, such as a rail, before the approval's transaction opens. */
  prepare?(request: RequestRow): Promise<P>;
  /** Run the held action as its requester, in the approval's transaction. */
  run(db: Tx, request: RequestRow, approver: ControlActor, prepared: P): Promise<R>;
  /** What must happen once that transaction has committed, such as waking a workflow. */
  after?(result: R): Promise<void>;
}

const executors = new Map<ApprovalKind, ApprovalExecutor<unknown, unknown>>();

/** Each module that can hold an action for approval says how to run it. */
export function registerApprovalExecutor<R, P = undefined>(
  kind: ApprovalKind,
  executor: ApprovalExecutor<R, P>,
) {
  executors.set(kind, executor as ApprovalExecutor<unknown, unknown>);
}

function executorOf(kind: ApprovalKind) {
  const executor = executors.get(kind);
  if (!executor) throw new Error(`No executor for ${kind}`);
  return executor;
}

const expiresAt = (r: { kind: ApprovalKind; createdAt: Date }) =>
  new Date(r.createdAt.getTime() + executorOf(r.kind).ttlMs);

/**
 * Refuse when two people are the same, or one invited or reset the other in the last 30 days.
 */
export async function assertIndependent(
  db: Tx,
  tenantId: string,
  requesterUserId: string | undefined,
  approverUserId: string,
): Promise<void> {
  if (!requesterUserId || requesterUserId === approverUserId) {
    throw new DomainError('conflict', 'A second person must approve what they did not ask for');
  }
  const since = new Date(Date.now() - RELATION_WINDOW_MS);
  const pair = (actor: string, target: string) =>
    and(
      sql`${controlEvents.actor}->>'userId' = ${actor}`,
      sql`${controlEvents.payload}->>'userId' = ${target}`,
    );
  const [tie] = await db
    .select({ id: controlEvents.id, type: controlEvents.type })
    .from(controlEvents)
    .where(
      and(
        eq(controlEvents.tenantId, tenantId),
        inArray(controlEvents.type, ['user_invited', 'user_reset']),
        gt(controlEvents.createdAt, since),
        or(pair(requesterUserId, approverUserId), pair(approverUserId, requesterUserId)),
      ),
    )
    .limit(1);
  if (tie) {
    throw new DomainError(
      'conflict',
      'The approver and the requester invited or reset one another in the last 30 days: someone independent must approve',
      { controlEventId: tie.id, type: tie.type },
    );
  }
}

/** Hold an action for a second person. Returns what the caller tells its client. */
export async function requestApproval(
  db: Tx,
  tenantId: string,
  principal: Principal,
  held: {
    /** Set when the request's id must follow from what it asks for, so asking again finds it. */
    id?: string;
    kind: ApprovalKind;
    payload: Record<string, unknown>;
    /** What it moves or hides, when that is one amount. */
    amount: bigint | null;
    currency: string | null;
    reason: string;
    /** A member's own control, decided only by that member's users. */
    memberId?: string;
  },
) {
  personOf(principal, 'ask for this');
  const actor = actorOf(principal);
  const [row] = await db
    .insert(approvalRequests)
    .values({ ...held, tenantId, actor })
    .returning({ id: approvalRequests.id, createdAt: approvalRequests.createdAt });
  if (!row) throw new Error('approval request was not recorded');
  await recordControl(db, tenantId, actor, {
    type: 'approval_requested',
    reason: held.reason,
    payload: {
      approvalId: row.id,
      kind: held.kind,
      amount: held.amount,
      currency: held.currency,
      requestedBy: principal.userId,
      request: held.payload,
      ...(held.memberId ? { memberId: held.memberId } : {}),
    },
  });
  return pendingOf({ id: row.id, kind: held.kind, createdAt: row.createdAt });
}

/** What a caller tells its client about a request still waiting for a second person. */
export const pendingOf = (r: { id: string; kind: ApprovalKind; createdAt: Date }) => ({
  status: 'pending_approval' as const,
  approvalId: r.id,
  kind: r.kind,
  expiresAt: expiresAt(r),
});
export type PendingApproval = Awaited<ReturnType<typeof requestApproval>>;

/** Where a request stands: still waiting for a second person, decided, or past its time. */
export async function requestStatus(db: Tx, r: RequestRow) {
  const [decided] = await db
    .select({ decision: approvalDecisions.decision })
    .from(approvalDecisions)
    .where(eq(approvalDecisions.requestId, r.id));
  if (decided) return decided.decision;
  return expiresAt(r) <= new Date() ? ('expired' as const) : ('pending' as const);
}

async function findRequest(db: Tx, tenantId: string, requestId: string) {
  parseInput(z.string().uuid(), requestId);
  const [r] = await db
    .select()
    .from(approvalRequests)
    .where(and(eq(approvalRequests.id, requestId), eq(approvalRequests.tenantId, tenantId)));
  if (!r) throw new DomainError('not_found', 'Approval request not found');
  return r;
}

/**
 * The request, locked so two people cannot decide it at once, if it is still open. The decision is
 * read after the lock, so whoever waited sees what the first one decided.
 */
async function openRequest(db: Tx, tenantId: string, requestId: string) {
  parseInput(z.string().uuid(), requestId);
  const [r] = await db
    .select()
    .from(approvalRequests)
    .where(and(eq(approvalRequests.id, requestId), eq(approvalRequests.tenantId, tenantId)))
    .for('update');
  if (!r) throw new DomainError('not_found', 'Approval request not found');
  const [decided] = await db
    .select({ decision: approvalDecisions.decision })
    .from(approvalDecisions)
    .where(eq(approvalDecisions.requestId, requestId));
  if (decided) throw new DomainError('conflict', `This request was already ${decided.decision}`);
  if (expiresAt(r) <= new Date()) {
    throw new DomainError('conflict', 'This request has expired: ask again');
  }
  return r;
}

/**
 * Whether this caller may decide the request, beyond being a second person: one of the kind's
 * approvers, and for a member's own request, a user of that member.
 */
const mayDecide = (principal: Principal, r: RequestRow) =>
  executorOf(r.kind).approvers.includes(principal.kind) &&
  (r.memberId === null || principal.memberId === r.memberId);

export const ApproveRequest = z.object({ note: z.string().trim().min(1).max(500).optional() });

/**
 * A second person approves a held action, which then runs exactly once, as its requester asked
 * it, in this same transaction. If it cannot run any more (the case moved on, the break closed),
 * nothing is recorded and the request stays open to be rejected.
 */
export async function approveRequest(
  tenantId: string,
  principal: Principal,
  requestId: string,
  input?: z.input<typeof ApproveRequest>,
) {
  const { note } = parseInput(ApproveRequest, input ?? {});
  const approver = personOf(principal, 'approve');
  const found = await findRequest(deps().db, tenantId, requestId);
  const executor = executorOf(found.kind);
  // Who may approve is settled before anything is read from outside for it.
  await assertIndependent(deps().db, tenantId, found.actor.userId, approver);
  if (!mayDecide(principal, found)) throw new DomainError('forbidden', "You can't approve that");
  const prepared = await executor.prepare?.(found);
  const result = await tx('approval_approve', async (db) => {
    const r = await openRequest(db, tenantId, requestId);
    const actor = actorOf(principal);
    const result = await executor.run(db, r, actor, prepared);
    await db
      .insert(approvalDecisions)
      .values({ requestId, tenantId, decision: 'approved', actor, reason: note ?? null });
    await recordControl(db, tenantId, actor, {
      type: 'approval_approved',
      reason: note ?? null,
      payload: {
        approvalId: requestId,
        kind: r.kind,
        amount: r.amount,
        currency: r.currency,
        requestedBy: r.actor,
      },
    });
    return result;
  });
  await executor.after?.(result);
  return { approvalId: requestId, status: 'approved' as const, kind: found.kind };
}

/** Turn a held action down. Nothing runs. The requester may withdraw their own request this way. */
export async function rejectRequest(
  tenantId: string,
  principal: Principal,
  requestId: string,
  input: z.input<typeof ReasonInput>,
) {
  const { reason } = parseInput(ReasonInput, input);
  personOf(principal, 'reject');
  return tx('approval_reject', async (db) => {
    const r = await openRequest(db, tenantId, requestId);
    const isRequester = r.actor.userId === principal.userId;
    if (!isRequester && !mayDecide(principal, r)) {
      throw new DomainError('forbidden', "You can't reject that");
    }
    const actor = actorOf(principal);
    await db
      .insert(approvalDecisions)
      .values({ requestId, tenantId, decision: 'rejected', actor, reason });
    await recordControl(db, tenantId, actor, {
      type: 'approval_rejected',
      reason,
      payload: { approvalId: requestId, kind: r.kind, requestedBy: r.actor },
    });
    return { approvalId: requestId, status: 'rejected' as const, kind: r.kind };
  });
}

export const ApprovalStatus = z.enum(['pending', 'decided', 'all']);

export const ListApprovals = z.object({
  kind: z.enum(approvalRequests.kind.enumValues).optional(),
  /** `pending` (the default) waits for a second person; `decided` was approved, rejected or expired. */
  status: ApprovalStatus.default('pending'),
});

/**
 * Held actions, newest first, of one kind and status if asked, within the window an auditor chose:
 * each with who asked and why, and who decided it, when and why, or when it expired.
 */
export async function listApprovals(
  tenantId: string,
  memberId: string | null,
  input?: z.input<typeof ListApprovals> & PopulationInput,
) {
  const { kind, status, ...window } = input ?? {};
  return approvalsIn(
    tenantId,
    memberId,
    populationOf(window, 100),
    parseInput(ListApprovals, { kind, status }),
  );
}

/**
 * Held actions in a window already decided, such as an export's. With `memberId`, only that
 * member's own requests.
 */
export async function approvalsIn(
  tenantId: string,
  memberId: string | null,
  w: Window,
  { kind, status }: z.output<typeof ListApprovals>,
) {
  const now = Date.now();
  const unexpired = or(
    ...[...executors].map(([k, e]) =>
      and(eq(approvalRequests.kind, k), gt(approvalRequests.createdAt, new Date(now - e.ttlMs))),
    ),
  );
  const open = and(isNull(approvalDecisions.id), unexpired);
  const rows = await deps()
    .db.select({ r: approvalRequests, d: approvalDecisions })
    .from(approvalRequests)
    .leftJoin(approvalDecisions, eq(approvalDecisions.requestId, approvalRequests.id))
    .where(
      and(
        eq(approvalRequests.tenantId, tenantId),
        memberId ? eq(approvalRequests.memberId, memberId) : undefined,
        kind ? eq(approvalRequests.kind, kind) : undefined,
        status === 'pending' ? open : status === 'decided' ? not(open ?? sql`false`) : undefined,
        ...within(approvalRequests.createdAt, approvalRequests.id, tenantId, w),
      ),
    )
    .orderBy(...newestFirst(approvalRequests.createdAt, approvalRequests.id))
    .limit(w.limit + 1);
  const page = pageOf(rows, w.limit, ({ r }) => r.id);
  return {
    rows: page.rows.map(({ r, d }) => {
      const expires = expiresAt(r);
      return {
        approvalId: r.id,
        kind: r.kind,
        memberId: r.memberId,
        status: d
          ? d.decision
          : expires.getTime() <= now
            ? ('expired' as const)
            : ('pending' as const),
        requestedBy: r.actor,
        reason: r.reason,
        amount: r.amount,
        currency: r.currency,
        payload: r.payload,
        requestedAt: r.createdAt,
        expiresAt: expires,
        // An approval's optional note or a rejection's reason.
        decision: d ? { by: d.actor, at: d.createdAt, reason: d.reason } : null,
        approvers: executorOf(r.kind).approvers,
      };
    }),
    next: page.next,
  };
}
