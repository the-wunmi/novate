import { DomainError, parseInput, sha256 } from '@novate/core';
import {
  controlEvents,
  dealEvents,
  deals,
  decisionCases,
  decisionOutcomes,
  decisionRecords,
  ledgerAccounts,
  ledgerTransfers,
  programs,
  reconRuns,
} from '@novate/db';
import {
  Action,
  type ActionCheck,
  checkAction,
  type Decisions,
  describeCheck,
} from '@novate/policy';
import { and, asc, count, desc, eq, gte, inArray, isNotNull, lt, ne, or, sql } from 'drizzle-orm';
import { z } from 'zod';
import { PeriodQuery } from './cycle-views.ts';
import { actionContext, recordedDecider } from './decisions.ts';
import { deps } from './deps.ts';
import { newestFirst, pageOf } from './page.ts';
import { type PopulationInput, populationOf, spanning, type Window, within } from './population.ts';

const FEED_SIZE = 100;
const EFFECTS = 50;

/** The ceiling the gate judged a case against, in its currency, as stored when the case opened. */
const caseCeiling = sql<
  string | null
>`${decisionCases.context}->'decisions'->'ceiling'->>(${decisionCases.context}->>'currency')`;
const caseModelCeiling = sql<
  string | null
>`${decisionCases.context}->'modelCeiling'->>(${decisionCases.context}->>'currency')`;

/**
 * Decisions of every kind, newest first, whoever made them, with how each turned out. `ceiling` is
 * the ceiling as it stood in the program version the case was judged under, which `programKey` and
 * `programVersion` name for a deal's case (others belong to no one program).
 */
export const decisionFeed = async (tenantId: string, input?: PopulationInput) =>
  decisionsIn(tenantId, populationOf(input, FEED_SIZE));

/**
 * Cases decided in a period, by when they closed, counted by who decided them: rules, a model or a
 * person.
 */
export async function decisionSummary(tenantId: string, input: z.input<typeof PeriodQuery> = {}) {
  const { from, to } = parseInput(PeriodQuery, input);
  const decider = sql<string>`${decisionCases.resolution}->'decider'->>'type'`;
  const rows = await deps()
    .db.select({ decider, n: count() })
    .from(decisionCases)
    .where(
      and(
        eq(decisionCases.tenantId, tenantId),
        isNotNull(decisionCases.resolution),
        from ? gte(decisionCases.closedAt, from) : undefined,
        to ? lt(decisionCases.closedAt, to) : undefined,
      ),
    )
    .groupBy(decider);
  const of = (type: string) => rows.find((r) => r.decider === type)?.n ?? 0;
  return {
    from: from ?? null,
    to: to ?? null,
    decided: rows.reduce((acc, r) => acc + r.n, 0),
    byRule: of('rule'),
    byModel: of('model'),
    byPerson: of('person'),
  };
}

/** Decisions in a window already decided, such as an export's. */
export async function decisionsIn(tenantId: string, w: Window) {
  const { db } = deps();
  const rows = await db
    .select({
      id: decisionCases.id,
      dealId: decisionCases.dealId,
      kind: decisionCases.kind,
      reason: decisionCases.reason,
      status: decisionCases.status,
      resolution: decisionCases.resolution,
      createdAt: decisionCases.createdAt,
      closedAt: decisionCases.closedAt,
      subjectType: decisionCases.subjectType,
      subjectId: decisionCases.subjectId,
      bindingHash: decisionCases.bindingHash,
      contextHash: decisionCases.contextHash,
      assignee: decisionCases.assignee,
      assignedAt: decisionCases.assignedAt,
      amount: sql<string>`${decisionCases.context}->>'amount'`,
      currency: sql<string>`${decisionCases.context}->>'currency'`,
      ceiling: caseCeiling,
      modelCeiling: caseModelCeiling,
      programKey: programs.key,
      programVersion: programs.version,
      buyerMemberId: deals.buyerMemberId,
      sellerMemberId: deals.sellerMemberId,
      verdict: decisionOutcomes.verdict,
    })
    .from(decisionCases)
    .leftJoin(decisionOutcomes, eq(decisionOutcomes.caseId, decisionCases.id))
    .leftJoin(deals, eq(deals.id, decisionCases.dealId))
    .leftJoin(programs, eq(programs.id, deals.programId))
    .where(
      and(
        eq(decisionCases.tenantId, tenantId),
        ...within(decisionCases.createdAt, decisionCases.id, tenantId, w),
      ),
    )
    .orderBy(...newestFirst(decisionCases.createdAt, decisionCases.id))
    .limit(w.limit + 1);
  const page = pageOf(rows, w.limit, (r) => r.id);
  const records = page.rows.length
    ? await db
        .select({ record: decisionRecords })
        .from(decisionRecords)
        .innerJoin(decisionCases, eq(decisionCases.id, decisionRecords.caseId))
        .where(
          and(
            eq(decisionCases.tenantId, tenantId),
            ...within(decisionCases.createdAt, decisionCases.id, tenantId, w),
            ...spanning(
              decisionCases.createdAt,
              page.rows.map((r) => r.createdAt),
            ),
          ),
        )
        .orderBy(asc(decisionRecords.createdAt), asc(decisionRecords.id))
    : [];
  const byCase = Map.groupBy(
    records.map((r) => r.record),
    (r) => r.caseId,
  );
  return {
    next: page.next,
    rows: page.rows.map((r) => {
      const steps = byCase.get(r.id) ?? [];
      // What closed the case: the last proposal the gate accepted, if any.
      const final = steps.findLast((s) => s.accepted === 1);
      const facts = final ? recordFacts(final) : null;
      return {
        ...r,
        ceiling: r.ceiling === null ? null : BigInt(r.ceiling),
        modelCeiling: r.modelCeiling === null ? null : BigInt(r.modelCeiling),
        rationale: final?.rationale ?? null,
        deciderName: facts ? (facts.operator ?? facts.model ?? final?.deciderId ?? null) : null,
        promptVersion: facts?.promptVersion ?? null,
        promptHash: facts?.promptHash ?? null,
        refusedProposals: steps.filter((s) => s.accepted !== 1).length,
      };
    }),
  };
}

/**
 * Who a record's decider was, beyond its type: for a model the model that answered and the exact
 * instructions it was given, for a person the name they gave.
 */
export function recordFacts(s: typeof decisionRecords.$inferSelect) {
  const m = s.metadata;
  return {
    model: s.deciderType === 'model' ? s.deciderId : null,
    promptVersion: m.promptVersion ?? null,
    promptHash: m.promptHash ?? null,
    operator: s.deciderType === 'person' ? (m.actor?.operator ?? null) : null,
  };
}

/** Every proposal any decider made in a window, one row each, newest first, as an export reads it. */
export async function decisionRecordsIn(tenantId: string, w: Window) {
  const rows = await deps()
    .db.select({ r: decisionRecords })
    .from(decisionRecords)
    .innerJoin(decisionCases, eq(decisionCases.id, decisionRecords.caseId))
    .where(
      and(
        eq(decisionCases.tenantId, tenantId),
        ...within(decisionRecords.createdAt, decisionRecords.id, tenantId, w),
      ),
    )
    .orderBy(...newestFirst(decisionRecords.createdAt, decisionRecords.id))
    .limit(w.limit + 1);
  return pageOf(
    rows.map(({ r }) => ({ ...r, ...recordFacts(r) })),
    w.limit,
    (r) => r.id,
  );
}

/**
 * The full story of one decision: what was shown, each proposal and refusal, what happened to the
 * deal and the money, and whether the record still matches the hash taken when it was shown.
 */
export async function decisionTrail(tenantId: string, caseId: string) {
  const { db } = deps();
  const row = await caseOf(tenantId, caseId);
  const context = row.context as unknown as CaseLimits;
  const subject = row.dealId ?? row.subjectId;
  const [steps, outcome, money, events] = await Promise.all([
    db
      .select()
      .from(decisionRecords)
      .where(eq(decisionRecords.caseId, caseId))
      .orderBy(asc(decisionRecords.createdAt)),
    db.select().from(decisionOutcomes).where(eq(decisionOutcomes.caseId, caseId)),
    db
      .select({
        kind: ledgerTransfers.kind,
        amount: ledgerTransfers.amount,
        currency: ledgerTransfers.currency,
        at: ledgerTransfers.createdAt,
      })
      .from(ledgerTransfers)
      .innerJoin(ledgerAccounts, eq(ledgerAccounts.id, ledgerTransfers.debitAccountId))
      .where(
        and(
          eq(ledgerTransfers.tenantId, tenantId),
          eq(ledgerTransfers.ref, subject),
          gte(ledgerTransfers.createdAt, row.createdAt),
          // Novation posts each obligation twice, in to the house and out of it: one is the story.
          or(ne(ledgerTransfers.kind, 'novation'), ne(ledgerAccounts.kind, 'clearing')),
        ),
      )
      .orderBy(asc(ledgerTransfers.createdAt))
      .limit(EFFECTS),
    row.dealId
      ? db
          .select({ type: dealEvents.type, payload: dealEvents.payload, at: dealEvents.createdAt })
          .from(dealEvents)
          .where(and(eq(dealEvents.dealId, row.dealId), gte(dealEvents.createdAt, row.createdAt)))
          .orderBy(asc(dealEvents.seq))
          .limit(EFFECTS)
      : Promise.resolve([]),
  ]);
  const controls = row.kind === 'recon_break' ? await reconAftermath(row) : [];
  return {
    case: {
      id: row.id,
      kind: row.kind,
      reason: row.reason,
      status: row.status,
      createdAt: row.createdAt,
      closedAt: row.closedAt,
      dealId: row.dealId,
      subject: { type: row.subjectType, id: row.subjectId },
      amount: context.amount,
      currency: context.currency,
      ceiling: context.decisions.ceiling[context.currency] ?? null,
      modelCeiling: context.modelCeiling[context.currency] ?? null,
      shown: row.shown,
    },
    ...integrityOf(row),
    steps: steps.map((s) => ({
      decider: s.deciderType,
      deciderId: s.deciderId,
      ...recordFacts(s),
      action: s.action,
      rationale: s.rationale,
      accepted: s.accepted === 1,
      checks: (s.checks as ActionCheck[]).map((c) => ({ ...c, text: describeCheck(c) })),
      at: s.createdAt,
    })),
    outcome: outcome[0] ?? null,
    events: [...events.map((e) => ({ source: 'deal' as const, ...e })), ...controls].sort(
      (a, b) => a.at.getTime() - b.at.getTime(),
    ),
    money,
  };
}

/** What makes a reconciliation case's story: settlement going on again, a new opening, breaks closed. */
const AFTERMATH = [
  'settlement_resumed',
  'opening_recorded',
  'break_resolved',
  'settlement_stopped',
] as const;

/**
 * What happened next for a reconciliation case: the control events on its rail (or naming it) from
 * when it opened, so the trail shows settlement resuming or an opening re-recorded, by whom and why.
 */
async function reconAftermath(row: typeof decisionCases.$inferSelect) {
  const { db } = deps();
  const [run] = await db
    .select({ rail: reconRuns.rail })
    .from(reconRuns)
    .where(
      and(eq(reconRuns.tenantId, row.tenantId), sql`${reconRuns.id}::text = ${row.subjectId}`),
    );
  const rows = await db
    .select()
    .from(controlEvents)
    .where(
      and(
        eq(controlEvents.tenantId, row.tenantId),
        inArray(controlEvents.type, [...AFTERMATH]),
        gte(controlEvents.createdAt, row.createdAt),
        or(
          inArray(controlEvents.type, ['settlement_resumed', 'settlement_stopped']),
          sql`${controlEvents.payload}->>'caseId' = ${row.id}`,
          ...(run ? [sql`${controlEvents.payload}->>'rail' = ${run.rail}`] : []),
        ),
      ),
    )
    .orderBy(asc(controlEvents.createdAt))
    .limit(EFFECTS);
  return rows.map((e) => ({
    source: 'control' as const,
    id: e.id,
    type: e.type,
    payload: e.payload,
    at: e.createdAt,
    actor: e.actor,
    reason: e.reason,
  }));
}

/**
 * Two separate checks, each recomputed from what is stored now. `shown` is what the decider saw,
 * bound by the binding hash. `context` is the amount and limits the gate judged against, bound by
 * the context hash.
 */
function integrityOf(row: typeof decisionCases.$inferSelect) {
  const shown = sha256(row.shown);
  const context = sha256(row.context);
  const shownMatches = shown === row.bindingHash;
  const contextMatches = context === row.contextHash;
  return {
    untampered: shownMatches && contextMatches,
    integrity: {
      shown: { recorded: row.bindingHash, computed: shown, matches: shownMatches },
      context: { recorded: row.contextHash, computed: context, matches: contextMatches },
    },
  };
}

interface CaseLimits {
  amount: string;
  currency: string;
  decisions: Decisions;
  modelCeiling: Record<string, number>;
}

async function caseOf(tenantId: string, caseId: string) {
  const [row] = await deps()
    .db.select()
    .from(decisionCases)
    .where(and(eq(decisionCases.id, caseId), eq(decisionCases.tenantId, tenantId)));
  if (!row) throw new DomainError('not_found', 'Case not found');
  return row;
}

export const RecheckDecision = z.object({
  /** The ceiling to test, per currency, in minor units. */
  ceiling: z.record(z.string().length(3), z.int().positive()),
});

/**
 * What code would say about the action that was taken, had the limits been different. Nothing is
 * applied or recorded: it shows the same gate refusing what it once allowed, or the reverse.
 */
export async function recheckDecision(
  tenantId: string,
  caseId: string,
  input: z.input<typeof RecheckDecision>,
) {
  const { ceiling } = parseInput(RecheckDecision, input);
  const row = await caseOf(tenantId, caseId);
  const [last] = await deps()
    .db.select()
    .from(decisionRecords)
    .where(eq(decisionRecords.caseId, caseId))
    .orderBy(desc(decisionRecords.createdAt))
    .limit(1);
  if (!last) throw new DomainError('invalid', 'Nothing has been proposed on this case yet');
  const action = Action.parse(last.action);
  const decider = recordedDecider(last);
  const candidate = { ...(row.context as unknown as CaseLimits).decisions, ceiling };
  const checks = checkAction(actionContext(row, decider, action, candidate), action).map((c) => ({
    ...c,
    text: describeCheck(c),
  }));
  return {
    action,
    decider,
    checks,
    accepted: checks.every((c) => c.passed),
  };
}
