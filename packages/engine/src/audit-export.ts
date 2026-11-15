import { type ControlActor, parseInput } from '@novate/core';
import {
  agents,
  cycles,
  dealEvents,
  deals,
  ledgerAccounts,
  ledgerTransfers,
  members,
  programs,
  settlementInstructions,
  x402Payments,
} from '@novate/db';
import { type ActionCheck, refusalsOf } from '@novate/policy';
import { and, eq, exists, isNotNull, or, sql } from 'drizzle-orm';
import { alias } from 'drizzle-orm/pg-core';
import { activityIn } from './activity.ts';
import { listApiKeys } from './api-keys.ts';
import { controlEventsIn } from './control.ts';
import { type CsvColumn, moneyColumns } from './csv.ts';
import { decisionRecordsIn, decisionsIn } from './decision-trail.ts';
import { deps } from './deps.ts';
import { approvalsIn, ListApprovals } from './four-eyes.ts';
import { newestFirst } from './page.ts';
import {
  type CsvExport,
  exportCsv,
  exportRange,
  inRange,
  type PopulationInput,
} from './population.ts';
import { reconRunsIn } from './recon-views.ts';
import { listUsers } from './users.ts';

/*
 * The same populations as the JSON routes, as CSV with fixed columns, for auditors who sample them
 * in a spreadsheet. Every amount names its unit: `_minor` beside `_major`. Each export is every row
 * in its range (`exportRange`: without `from`, the last 31 days), or refused as too large: never a
 * page of it.
 */

const actorColumns = <T>(get: (row: T) => ControlActor | null | undefined, prefix = 'actor') =>
  [
    [`${prefix}_kind`, (r: T) => get(r)?.kind],
    [`${prefix}_key_id`, (r: T) => get(r)?.keyId],
    [`${prefix}_name`, (r: T) => get(r)?.name],
    [`${prefix}_operator`, (r: T) => get(r)?.operator],
    [`${prefix}_user_id`, (r: T) => get(r)?.userId],
    [`${prefix}_via`, (r: T) => get(r)?.via],
  ] as [string, (r: T) => unknown][];

type ControlRow = Awaited<ReturnType<typeof controlEventsIn>>['rows'][number];

export async function controlEventsCsv(
  tenantId: string,
  input?: PopulationInput,
): Promise<CsvExport> {
  const { range, window } = exportRange(input);
  return exportCsv<ControlRow>(
    [
      ['id', (r) => r.id],
      ['at', (r) => r.createdAt],
      ['type', (r) => r.type],
      ...actorColumns<ControlRow>((r) => r.actor),
      ['reason', (r) => r.reason],
      ['payload', (r) => r.payload],
    ],
    (await controlEventsIn(tenantId, window)).rows,
    range,
  );
}

type DecisionRow = Awaited<ReturnType<typeof decisionsIn>>['rows'][number];

export async function decisionsCsv(tenantId: string, input?: PopulationInput): Promise<CsvExport> {
  const { range, window } = exportRange(input);
  return exportCsv<DecisionRow>(
    [
      ['case_id', (r) => r.id],
      ['opened_at', (r) => r.createdAt],
      ['closed_at', (r) => r.closedAt],
      ['kind', (r) => r.kind],
      ['subject_type', (r) => r.subjectType],
      ['subject_id', (r) => r.subjectId],
      ['deal_id', (r) => r.dealId],
      ['reason', (r) => r.reason],
      ['status', (r) => r.status],
      ...moneyColumns<DecisionRow>(
        'amount',
        (r) => r.amount,
        (r) => r.currency,
      ),
      ['currency', (r) => r.currency],
      ['action', (r) => r.resolution?.action.type],
      ['decider_type', (r) => r.resolution?.decider.type],
      ['decider_id', (r) => r.resolution?.decider.id],
      ['verdict', (r) => r.verdict],
      ['binding_hash', (r) => r.bindingHash],
      ['context_hash', (r) => r.contextHash],
      ['rationale', (r) => r.rationale],
      ['decider_name', (r) => r.deciderName],
      ['prompt_version', (r) => r.promptVersion],
      ['prompt_hash', (r) => r.promptHash],
      ['refused_proposals', (r) => r.refusedProposals],
      ...moneyColumns<DecisionRow>(
        'ceiling',
        (r) => r.ceiling,
        (r) => r.currency,
      ),
      ['program_key', (r) => r.programKey],
      ['program_version', (r) => r.programVersion],
      ['decider_user_id', (r) => r.resolution?.decider.actor?.userId],
    ],
    (await decisionsIn(tenantId, window)).rows,
    range,
  );
}

type RecordRow = Awaited<ReturnType<typeof decisionRecordsIn>>['rows'][number];

/** Every proposal, accepted or refused, one row each, with who or what made it and on what prompt. */
export async function decisionRecordsCsv(
  tenantId: string,
  input?: PopulationInput,
): Promise<CsvExport> {
  const { range, window } = exportRange(input);
  return exportCsv<RecordRow>(
    [
      ['case_id', (r) => r.caseId],
      ['at', (r) => r.createdAt],
      ['decider_type', (r) => r.deciderType],
      ['decider_id', (r) => r.deciderId],
      ['operator', (r) => r.operator],
      ['model', (r) => r.model],
      ['prompt_version', (r) => r.promptVersion],
      ['prompt_hash', (r) => r.promptHash],
      ['action', (r) => r.action.type],
      ['accepted', (r) => r.accepted === 1],
      ['refused_because', (r) => refusalsOf(r.checks as ActionCheck[]).join('; ')],
      ['rationale', (r) => r.rationale],
      ['decider_user_id', (r) => r.metadata.actor?.userId],
      ['approved_by_user_id', (r) => r.metadata.approvedBy?.userId],
    ],
    (await decisionRecordsIn(tenantId, window)).rows,
    range,
  );
}

/**
 * Every ledger transfer in the window, newest first, with both accounts by code and by what they
 * are: their kind and owner (member, deal, cycle, rail), as written when each account was opened.
 */
export async function ledgerCsv(tenantId: string, input?: PopulationInput): Promise<CsvExport> {
  const { range, window: w } = exportRange(input);
  const debit = alias(ledgerAccounts, 'debit');
  const credit = alias(ledgerAccounts, 'credit');
  const debitMember = alias(members, 'debit_member');
  const creditMember = alias(members, 'credit_member');
  const rows = await deps()
    .db.select({
      t: ledgerTransfers,
      debit: {
        code: debit.code,
        kind: debit.kind,
        memberId: debit.memberId,
        memberName: debitMember.name,
        dealId: debit.dealId,
        cycleId: debit.cycleId,
        rail: debit.rail,
      },
      credit: {
        code: credit.code,
        kind: credit.kind,
        memberId: credit.memberId,
        memberName: creditMember.name,
        dealId: credit.dealId,
        cycleId: credit.cycleId,
        rail: credit.rail,
      },
      dealId: deals.id,
      cycleId: cycles.id,
    })
    .from(ledgerTransfers)
    .innerJoin(debit, eq(debit.id, ledgerTransfers.debitAccountId))
    .innerJoin(credit, eq(credit.id, ledgerTransfers.creditAccountId))
    .leftJoin(debitMember, eq(debitMember.id, debit.memberId))
    .leftJoin(creditMember, eq(creditMember.id, credit.memberId))
    // A transfer's reference names the deal or the cycle it belongs to, when it belongs to one.
    .leftJoin(
      deals,
      and(eq(deals.tenantId, tenantId), sql`${deals.id}::text = ${ledgerTransfers.ref}`),
    )
    .leftJoin(
      cycles,
      and(eq(cycles.tenantId, tenantId), sql`${cycles.id}::text = ${ledgerTransfers.ref}`),
    )
    .where(and(eq(ledgerTransfers.tenantId, tenantId), ...inRange(ledgerTransfers.createdAt, w)))
    .orderBy(...newestFirst(ledgerTransfers.createdAt, ledgerTransfers.id))
    .limit(w.limit);
  type Row = (typeof rows)[number];
  const account = (side: 'debit' | 'credit'): [string, (r: Row) => unknown][] => [
    [`${side}_account`, (r) => r[side].code],
    [`${side}_kind`, (r) => r[side].kind],
    [`${side}_member_id`, (r) => r[side].memberId],
    [`${side}_member_name`, (r) => r[side].memberName],
    [`${side}_deal_id`, (r) => r[side].dealId],
    [`${side}_cycle_id`, (r) => r[side].cycleId],
    [`${side}_rail`, (r) => r[side].rail],
  ];
  return exportCsv<Row>(
    [
      ['id', (r) => r.t.id],
      ['at', (r) => r.t.createdAt],
      ['kind', (r) => r.t.kind],
      ...account('debit'),
      ...account('credit'),
      ...moneyColumns<Row>(
        'amount',
        (r) => r.t.amount,
        (r) => r.t.currency,
      ),
      ['currency', (r) => r.t.currency],
      ['idempotency_key', (r) => r.t.idempotencyKey],
      ['reference', (r) => r.t.ref],
      ['batch_id', (r) => r.t.batchId],
      ['deal_id', (r) => r.dealId],
      ['cycle_id', (r) => r.cycleId],
    ],
    rows,
    range,
  );
}

/** Every settlement instruction, collections and payouts alike, newest first. */
export async function payoutsCsv(tenantId: string, input?: PopulationInput): Promise<CsvExport> {
  const { range, window: w } = exportRange(input);
  const rows = await deps()
    .db.select()
    .from(settlementInstructions)
    .where(
      and(
        eq(settlementInstructions.tenantId, tenantId),
        ...inRange(settlementInstructions.createdAt, w),
      ),
    )
    .orderBy(...newestFirst(settlementInstructions.createdAt, settlementInstructions.id))
    .limit(w.limit);
  type Row = (typeof rows)[number];
  return exportCsv<Row>(
    [
      ['id', (r) => r.id],
      ['cycle_id', (r) => r.cycleId],
      ['member_id', (r) => r.memberId],
      ['direction', (r) => r.direction],
      ['rail', (r) => r.rail],
      ['currency', (r) => r.currency],
      ...moneyColumns<Row>(
        'amount',
        (r) => r.amount,
        (r) => r.currency,
      ),
      ['status', (r) => r.status],
      ['attempt', (r) => r.attempt],
      ['external_ref', (r) => r.externalRef],
      ['failure_reason', (r) => r.failureReason],
      ['created_at', (r) => r.createdAt],
      ['updated_at', (r) => r.updatedAt],
    ],
    rows,
    range,
  );
}

/**
 * Every deal, newest first, with the program version it runs under, the agents that struck it and
 * how the buyer funded it. With `memberId`, only the deals that member is a party to.
 */
export async function dealsCsv(
  tenantId: string,
  memberId: string | null,
  input?: PopulationInput,
): Promise<CsvExport> {
  const { range, window: w } = exportRange(input);
  const { db } = deps();
  const byCard = exists(
    db
      .select({ one: sql`1` })
      .from(dealEvents)
      .where(and(eq(dealEvents.dealId, deals.id), eq(dealEvents.type, 'card_funded'))),
  );
  const byX402 = exists(
    db
      .select({ one: sql`1` })
      .from(x402Payments)
      .where(and(eq(x402Payments.dealId, deals.id), isNotNull(x402Payments.claimedRef))),
  );
  const buyer = alias(members, 'buyer');
  const seller = alias(members, 'seller');
  const buyerAgent = alias(agents, 'buyer_agent');
  const sellerAgent = alias(agents, 'seller_agent');
  const rows = await db
    .select({
      d: deals,
      programKey: programs.key,
      programVersion: programs.version,
      buyerName: buyer.name,
      sellerName: seller.name,
      buyerAgentName: buyerAgent.name,
      sellerAgentName: sellerAgent.name,
      byCard: sql<boolean>`${byCard}`,
      byX402: sql<boolean>`${byX402}`,
    })
    .from(deals)
    .innerJoin(programs, eq(programs.id, deals.programId))
    .innerJoin(buyer, eq(buyer.id, deals.buyerMemberId))
    .innerJoin(seller, eq(seller.id, deals.sellerMemberId))
    .leftJoin(buyerAgent, eq(buyerAgent.id, deals.buyerAgentId))
    .leftJoin(sellerAgent, eq(sellerAgent.id, deals.sellerAgentId))
    .where(
      and(
        eq(deals.tenantId, tenantId),
        memberId
          ? or(eq(deals.buyerMemberId, memberId), eq(deals.sellerMemberId, memberId))
          : undefined,
        ...inRange(deals.createdAt, w),
      ),
    )
    .orderBy(...newestFirst(deals.createdAt, deals.id))
    .limit(w.limit);
  type Row = (typeof rows)[number];
  return exportCsv<Row>(
    [
      ['id', (r) => r.d.id],
      ['created_at', (r) => r.d.createdAt],
      ['program_key', (r) => r.programKey],
      ['program_version', (r) => r.programVersion],
      ['buyer_member_id', (r) => r.d.buyerMemberId],
      ['buyer_name', (r) => r.buyerName],
      ['seller_member_id', (r) => r.d.sellerMemberId],
      ['seller_name', (r) => r.sellerName],
      ['buyer_agent_id', (r) => r.d.buyerAgentId],
      ['buyer_agent_name', (r) => r.buyerAgentName],
      ['seller_agent_id', (r) => r.d.sellerAgentId],
      ['seller_agent_name', (r) => r.sellerAgentName],
      ...moneyColumns<Row>(
        'amount',
        (r) => r.d.amount,
        (r) => r.d.currency,
      ),
      ['currency', (r) => r.d.currency],
      ['status', (r) => r.d.status],
      ...moneyColumns<Row>(
        'release_amount',
        (r) => r.d.releaseAmount,
        (r) => r.d.currency,
      ),
      // Card or x402 when the buyer paid that way; otherwise from its wallet.
      ['funding', (r) => (r.byCard ? 'card' : r.byX402 ? 'x402' : 'wallet')],
    ],
    rows,
    range,
  );
}

type ActivityRow = Awaited<ReturnType<typeof activityIn>>['rows'][number];

export async function activityCsv(tenantId: string, input?: PopulationInput): Promise<CsvExport> {
  const { range, window } = exportRange(input);
  return exportCsv<ActivityRow>(
    [
      ['id', (r) => r.id],
      ['at', (r) => r.at],
      ['source', (r) => r.source],
      ['type', (r) => r.type],
      ['deal_id', (r) => r.dealId],
      ['case_id', (r) => r.caseId],
      ...moneyColumns<ActivityRow>(
        'amount',
        (r) => r.amount,
        (r) => r.currency,
      ),
      ['currency', (r) => r.currency],
      ...actorColumns<ActivityRow>((r) => r.actor),
      ['detail', (r) => r.detail],
    ],
    (await activityIn(tenantId, window)).rows,
    range,
  );
}

type ReconLine = {
  run: Awaited<ReturnType<typeof reconRunsIn>>['rows'][number];
  b?: Awaited<ReturnType<typeof reconRunsIn>>['rows'][number]['breaks'][number];
};

/** One line per break, and one for each run that found none. */
export async function reconciliationCsv(
  tenantId: string,
  input?: PopulationInput,
): Promise<CsvExport> {
  const { range, window } = exportRange(input);
  const { rows: runs } = await reconRunsIn(tenantId, window);
  const lines: ReconLine[] = runs.flatMap((run) =>
    run.breaks.length ? run.breaks.map((b) => ({ run, b })) : [{ run }],
  );
  return exportCsv<ReconLine>(
    [
      ['run_id', (l) => l.run.id],
      ['run_at', (l) => l.run.at],
      ['rail', (l) => l.run.rail],
      ['run_status', (l) => l.run.status],
      ['break_id', (l) => l.b?.id],
      ['kind', (l) => l.b?.kind],
      ['currency', (l) => l.b?.currency],
      ...moneyColumns<ReconLine>(
        'expected',
        (l) => l.b?.expected,
        (l) => l.b?.currency,
      ),
      ...moneyColumns<ReconLine>(
        'actual',
        (l) => l.b?.actual,
        (l) => l.b?.currency,
      ),
      ['external_ref', (l) => l.b?.externalRef],
      ['break_status', (l) => l.b?.status],
      ['resolution', (l) => l.b?.resolution?.resolution],
      ['resolved_at', (l) => l.b?.resolution?.at],
      ...actorColumns<ReconLine>((l) => l.b?.resolution?.actor, 'resolved_by'),
      ['resolution_reason', (l) => l.b?.resolution?.reason],
      ['resolution_reference', (l) => l.b?.resolution?.reference],
      ['age_seconds', (l) => l.b?.ageSeconds],
      ['counts_as_item', (l) => l.b?.countsAsItem],
    ],
    lines,
    range,
  );
}

type PositionLine = {
  run: Awaited<ReturnType<typeof reconRunsIn>>['rows'][number];
  p: { currency: string; ledger: string; rail: string; atOpening: string };
};

/**
 * What each check compared, one line per run and currency: the ledger, the rail and the opening,
 * so a clean run carries its figures and not only its verdict.
 */
export async function reconPositionsCsv(
  tenantId: string,
  input?: PopulationInput,
): Promise<CsvExport> {
  const { range, window } = exportRange(input);
  const { rows: runs } = await reconRunsIn(tenantId, window);
  const lines: PositionLine[] = runs.flatMap((run) =>
    run.summary.kind === 'comparison' ? run.summary.positions.map((p) => ({ run, p })) : [],
  );
  const of = (l: PositionLine) => l.p.currency;
  return exportCsv<PositionLine>(
    [
      ['run_id', (l) => l.run.id],
      ['run_at', (l) => l.run.at],
      ['rail', (l) => l.run.rail],
      ['run_status', (l) => l.run.status],
      [
        'transactions',
        (l) => (l.run.summary.kind === 'comparison' ? l.run.summary.transactions : ''),
      ],
      ['currency', of],
      ...moneyColumns<PositionLine>('ledger', (l) => l.p.ledger, of),
      ...moneyColumns<PositionLine>('rail_balance', (l) => l.p.rail, of),
      ...moneyColumns<PositionLine>('at_opening', (l) => l.p.atOpening, of),
      ...moneyColumns<PositionLine>('difference', (l) => BigInt(l.p.rail) - BigInt(l.p.ledger), of),
    ],
    lines,
    range,
  );
}

type ApprovalRow = Awaited<ReturnType<typeof approvalsIn>>['rows'][number];

/** Every held action asked for in the range, whatever became of it. */
export async function approvalsCsv(
  tenantId: string,
  input?: PopulationInput & { kind?: string },
): Promise<CsvExport> {
  const { range, window } = exportRange(input);
  const filter = parseInput(ListApprovals, { kind: input?.kind || undefined, status: 'all' });
  return exportCsv<ApprovalRow>(
    [
      ['id', (r) => r.approvalId],
      ['kind', (r) => r.kind],
      ['status', (r) => r.status],
      ['requested_at', (r) => r.requestedAt],
      ...actorColumns<ApprovalRow>((r) => r.requestedBy, 'requested_by'),
      ['reason', (r) => r.reason],
      ['currency', (r) => r.currency],
      ...moneyColumns<ApprovalRow>(
        'amount',
        (r) => r.amount,
        (r) => r.currency,
      ),
      ['expires_at', (r) => r.expiresAt],
      ['decided_at', (r) => r.decision?.at],
      ...actorColumns<ApprovalRow>((r) => r.decision?.by, 'decided_by'),
      ['decision_reason', (r) => r.decision?.reason],
      ['request', (r) => r.payload],
    ],
    (await approvalsIn(tenantId, null, window, filter)).rows,
    range,
  );
}

/**
 * Who could act as things stand, for an access review: a snapshot of now, not a range, so nobody
 * added long ago is left out. Its range runs from the oldest row to now.
 */
function snapshotCsv<T extends { createdAt: Date }>(
  columns: readonly CsvColumn<T>[],
  rows: readonly T[],
): CsvExport {
  const to = new Date();
  const from = new Date(Math.min(to.getTime(), ...rows.map((r) => r.createdAt.getTime())));
  return exportCsv(columns, rows, { from, to, defaulted: false });
}

/** Every person with an account: role, status, two-step, last sign-in and any open invite. */
export async function usersCsv(tenantId: string): Promise<CsvExport> {
  const [people, names] = await Promise.all([listUsers(tenantId), memberNames(tenantId)]);
  type Row = (typeof people)[number];
  return snapshotCsv<Row>(
    [
      ['id', (u) => u.id],
      ['email', (u) => u.email],
      ['name', (u) => u.name],
      ['role', (u) => u.role],
      ['member_id', (u) => u.memberId],
      ['member_name', (u) => (u.memberId ? names.get(u.memberId) : undefined)],
      ['status', (u) => u.status],
      ['two_step', (u) => u.mfa],
      ['created_at', (u) => u.createdAt],
      ...actorColumns<Row>((u) => u.createdBy, 'created_by'),
      ['last_signed_in_at', (u) => u.lastLoginAt],
      ['invite_expires_at', (u) => u.inviteExpiresAt],
      ['locked_until', (u) => u.lockedUntil],
    ],
    people,
  );
}

/** Every key, live and revoked, with who issued and revoked it and when it was last used. */
export async function keysCsv(tenantId: string): Promise<CsvExport> {
  const [keys, names, agentRows] = await Promise.all([
    listApiKeys(tenantId),
    memberNames(tenantId),
    deps()
      .db.select({ id: agents.id, name: agents.name })
      .from(agents)
      .where(eq(agents.tenantId, tenantId)),
  ]);
  const agentNames = new Map(agentRows.map((a) => [a.id, a.name]));
  type Row = (typeof keys)[number];
  return snapshotCsv<Row>(
    [
      ['id', (k) => k.id],
      ['name', (k) => k.name],
      ['kind', (k) => k.principal],
      ['member_id', (k) => k.memberId],
      ['member_name', (k) => (k.memberId ? names.get(k.memberId) : undefined)],
      ['agent_id', (k) => k.agentId],
      ['agent_name', (k) => (k.agentId ? agentNames.get(k.agentId) : undefined)],
      ['active', (k) => k.active],
      ['created_at', (k) => k.createdAt],
      ...actorColumns<Row>((k) => k.createdBy, 'created_by'),
      ['last_used_at', (k) => k.lastUsedAt],
      ['revoked_at', (k) => k.revokedAt],
      ...actorColumns<Row>((k) => k.revokedBy, 'revoked_by'),
    ],
    keys,
  );
}

async function memberNames(tenantId: string) {
  const rows = await deps()
    .db.select({ id: members.id, name: members.name })
    .from(members)
    .where(eq(members.tenantId, tenantId));
  return new Map(rows.map((m) => [m.id, m.name]));
}
