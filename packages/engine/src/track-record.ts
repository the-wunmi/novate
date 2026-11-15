import { TERMINAL_DEAL_STATUSES } from '@novate/core';
import {
  agents,
  cycles,
  dealFacts,
  deals,
  decisionCases,
  decisionOutcomes,
  marginCalls,
  programs,
  reconRuns,
  type Tx,
} from '@novate/db';
import {
  type Action,
  type CaseKind,
  confidentScore,
  type Decisions,
  earnedCeiling,
  earnedShareBps,
  type JudgedDecision,
  judgeDecision,
  type OutcomeSignals,
  ProgramSpec,
  tallyRecord,
} from '@novate/policy';
import { and, asc, desc, eq, gt, gte, inArray, isNull, lte, ne, or, sql } from 'drizzle-orm';
import { deps } from './deps.ts';
import { decidedAction } from './repo.ts';

type CaseRow = typeof decisionCases.$inferSelect;
type DealRow = typeof deals.$inferSelect;

const BATCH = 200;
/** A track record reflects how agents are doing now, not how they did a year ago. */
const RECORD_WINDOW = 200;
const RESUBMIT_WINDOW_MS = 7 * 86_400_000;
const AGENT_WATCH_MS = 7 * 86_400_000;
const JUDGE_AGAIN_MS = 3_600_000;

async function dealSignals(db: Tx, c: CaseRow, action: Action): Promise<OutcomeSignals> {
  const [deal] = await db
    .select()
    .from(deals)
    .where(eq(deals.id, c.dealId as string));
  const row = deal as DealRow;
  const facts = await db
    .select({ id: dealFacts.id, kind: dealFacts.kind, data: dealFacts.data })
    .from(dealFacts)
    .where(eq(dealFacts.dealId, row.id));
  const resolved = new Set(
    facts.filter((f) => f.kind === 'dispute_resolved').map((f) => f.data.disputeId),
  );
  const unresolved = facts.filter((f) => f.kind === 'dispute' && !resolved.has(f.id));
  const open = !(TERMINAL_DEAL_STATUSES as readonly string[]).includes(row.status);
  const context = c.context as { evidence?: { currentBps?: number } };
  const raisedReserve =
    action.type === 'margin_call' ||
    (action.type === 'resize_margin' && action.bps > (context.evidence?.currentBps ?? 0));
  return {
    subject: 'deal',
    status: open
      ? 'open'
      : row.status === 'settled' || row.status === 'refunded'
        ? row.status
        : 'cancelled',
    disputed: unresolved.length > 0,
    resubmittedAndSettled: await resubmittedAndSettled(db, row),
    resubmitWindowOver: Date.now() - row.createdAt.getTime() >= RESUBMIT_WINDOW_MS,
    raisedReserve,
  };
}

/** A later deal with the same parties and amount that settled means the stop was a false alarm. */
async function resubmittedAndSettled(db: Tx, d: DealRow): Promise<boolean> {
  const [later] = await db
    .select({ id: deals.id })
    .from(deals)
    .where(
      and(
        eq(deals.tenantId, d.tenantId),
        eq(deals.buyerMemberId, d.buyerMemberId),
        eq(deals.sellerMemberId, d.sellerMemberId),
        eq(deals.amount, d.amount),
        eq(deals.status, 'settled'),
        ne(deals.id, d.id),
        gt(deals.createdAt, d.createdAt),
        sql`${deals.createdAt} < ${new Date(d.createdAt.getTime() + RESUBMIT_WINDOW_MS)}`,
      ),
    )
    .limit(1);
  return Boolean(later);
}

async function callSignals(db: Tx, c: CaseRow): Promise<OutcomeSignals> {
  const [call] = await db
    .select({ status: marginCalls.status })
    .from(marginCalls)
    .where(
      and(eq(marginCalls.memberId, c.subjectId), sql`${marginCalls.createdAt} <= ${c.createdAt}`),
    )
    .orderBy(desc(marginCalls.createdAt))
    .limit(1);
  return { subject: 'call', status: call?.status ?? 'open' };
}

const failedAnyone = (summary: unknown) =>
  Boolean((summary as { failures?: unknown[] } | null)?.failures?.length);

function cycleSignals(cycle: typeof cycles.$inferSelect | undefined): OutcomeSignals {
  if (cycle?.status !== 'settled' && cycle?.status !== 'failed') {
    return { subject: 'cycle', status: 'open', anyoneFailed: false };
  }
  return { subject: 'cycle', status: cycle.status, anyoneFailed: failedAnyone(cycle.summary) };
}

async function nextCycleOfGroup(db: Tx, c: CaseRow) {
  const [cycle] = await db
    .select()
    .from(cycles)
    .where(
      and(
        eq(cycles.settlementGroup, c.subjectId),
        ne(cycles.status, 'deferred'),
        // A cycle that found nothing it could settle says nothing about the decision.
        sql`${cycles.summary}->>'obligations' is distinct from '0'`,
        gte(cycles.createdAt, c.createdAt),
      ),
    )
    .orderBy(asc(cycles.createdAt))
    .limit(1);
  return cycle;
}

async function reconSignals(db: Tx, c: CaseRow): Promise<OutcomeSignals> {
  const [run] = await db.select().from(reconRuns).where(eq(reconRuns.id, c.subjectId));
  const [next] = await db
    .select({ status: reconRuns.status })
    .from(reconRuns)
    .where(
      and(
        eq(reconRuns.tenantId, c.tenantId),
        eq(reconRuns.rail, run?.rail ?? ''),
        gt(reconRuns.createdAt, c.createdAt),
      ),
    )
    .orderBy(asc(reconRuns.createdAt))
    .limit(1);
  return {
    subject: 'recon',
    next: next ? (next.status === 'clean' ? 'clean' : 'breaks') : 'pending',
  };
}

async function agentSignals(db: Tx, c: CaseRow): Promise<OutcomeSignals> {
  const matured = Date.now() - c.createdAt.getTime() >= AGENT_WATCH_MS;
  const [agent] = await db
    .select({ status: agents.status })
    .from(agents)
    .where(eq(agents.id, c.subjectId));
  return { subject: 'agent', matured, suspendedAgain: agent?.status === 'blocked' };
}

async function signalsFor(db: Tx, c: CaseRow, action: Action) {
  if (c.dealId) return dealSignals(db, c, action);
  switch (c.subjectType) {
    case 'member':
      return callSignals(db, c);
    case 'group':
      return cycleSignals(await nextCycleOfGroup(db, c));
    case 'cycle': {
      const [cycle] = await db.select().from(cycles).where(eq(cycles.id, c.subjectId));
      return cycleSignals(cycle);
    }
    case 'rail':
      return reconSignals(db, c);
    case 'agent':
      return agentSignals(db, c);
    default:
      return null;
  }
}

/** Look at model decisions old enough to judge, and record how each one turned out. */
export async function judgeMaturedDecisions(db: Tx, tenantId: string): Promise<number> {
  const now = new Date();
  // A decision about a deal can only be judged once the deal is over, so open deals are not looked
  // at, and the first look after a deal closes judges it, with no wait left over from earlier.
  const pending = await db
    .select({ c: decisionCases })
    .from(decisionCases)
    .leftJoin(decisionOutcomes, eq(decisionOutcomes.caseId, decisionCases.id))
    .leftJoin(deals, eq(deals.id, decisionCases.dealId))
    .where(
      and(
        eq(decisionCases.tenantId, tenantId),
        eq(decisionCases.status, 'decided'),
        isNull(decisionOutcomes.caseId),
        or(isNull(decisionCases.dealId), inArray(deals.status, [...TERMINAL_DEAL_STATUSES])),
        or(isNull(decisionCases.judgeAfter), lte(decisionCases.judgeAfter, now)),
        sql`${decisionCases.resolution}->'decider'->>'type' = 'model'`,
      ),
    )
    .orderBy(asc(decisionCases.createdAt))
    .limit(BATCH);
  let judged = 0;
  for (const { c } of pending) {
    const action = decidedAction(c);
    const signals = await signalsFor(db, c, action);
    const verdict = signals && judgeDecision(c.kind as CaseKind, action.type, signals);
    if (!verdict) {
      // Set aside for a while, so long-running cases cannot crowd out ones ready to be judged.
      await db
        .update(decisionCases)
        .set({ judgeAfter: new Date(now.getTime() + JUDGE_AGAIN_MS) })
        .where(eq(decisionCases.id, c.id));
      continue;
    }
    const context = c.context as { amount: string; currency: string };
    await db
      .insert(decisionOutcomes)
      .values({
        caseId: c.id,
        tenantId,
        kind: c.kind,
        actionType: action.type,
        verdict,
        signals: signals as unknown as Record<string, unknown>,
        programKey: await programKeyOf(db, c),
        amount: BigInt(context.amount),
        currency: context.currency,
        pair: await pairOf(db, c),
      })
      .onConflictDoNothing();
    judged++;
  }
  return judged;
}

type CaseIdentity = Pick<CaseRow, 'dealId' | 'subjectType' | 'subjectId'>;

/** A track record belongs to a program by name, so publishing a new version does not reset it. */
async function programKeyOf(db: Tx, c: CaseIdentity): Promise<string | null> {
  let programId: string | undefined;
  if (c.dealId) {
    const [deal] = await db
      .select({ programId: deals.programId })
      .from(deals)
      .where(eq(deals.id, c.dealId));
    programId = deal?.programId;
  } else if (c.subjectType === 'group') {
    programId = c.subjectId.split('|')[3];
  }
  if (!programId) return null;
  const [program] = await db
    .select({ key: programs.key })
    .from(programs)
    .where(eq(programs.id, programId));
  return program?.key ?? null;
}

async function pairOf(db: Tx, c: CaseRow): Promise<string | null> {
  if (!c.dealId) return null;
  const [deal] = await db.select().from(deals).where(eq(deals.id, c.dealId));
  return deal ? [deal.buyerMemberId, deal.sellerMemberId].sort().join('|') : null;
}

async function judgedDecisions(
  db: Tx,
  tenantId: string,
  kind: string,
  programKey: string | null,
): Promise<JudgedDecision[]> {
  return db
    .select({
      verdict: decisionOutcomes.verdict,
      amount: decisionOutcomes.amount,
      currency: decisionOutcomes.currency,
      pair: decisionOutcomes.pair,
    })
    .from(decisionOutcomes)
    .where(
      and(
        eq(decisionOutcomes.tenantId, tenantId),
        eq(decisionOutcomes.kind, kind),
        programKey
          ? eq(decisionOutcomes.programKey, programKey)
          : isNull(decisionOutcomes.programKey),
      ),
    )
    .orderBy(desc(decisionOutcomes.createdAt))
    .limit(RECORD_WINDOW);
}

/** The most a model may decide on this kind of case today. Never above the tenant's ceiling. */
export async function modelCeilingFor(
  db: Tx,
  spec: CaseIdentity & { tenantId: string; kind: string; decisions: Decisions },
): Promise<Record<string, number>> {
  const { autonomy, ceiling } = spec.decisions;
  if (autonomy.mode === 'fixed') return ceiling;
  const programKey = await programKeyOf(db, spec);
  const judged = await judgedDecisions(db, spec.tenantId, spec.kind, programKey);
  return earnedCeiling(ceiling, earnedShareBps(tallyRecord(judged, autonomy, ceiling), autonomy));
}

/** For each program with earned limits and each kind of decision: the record and the share. */
export async function trackRecords(tenantId: string) {
  const { db } = deps();
  const tx = db as unknown as Tx;
  const kinds = await db
    .selectDistinct({ kind: decisionOutcomes.kind, programKey: decisionOutcomes.programKey })
    .from(decisionOutcomes)
    .where(eq(decisionOutcomes.tenantId, tenantId));
  // Oldest first, so that the latest version of each program wins.
  const rows = await db
    .select()
    .from(programs)
    .where(eq(programs.tenantId, tenantId))
    .orderBy(asc(programs.version));
  const specs = new Map(rows.map((p) => [p.key, ProgramSpec.parse(p.spec).decisions]));
  return Promise.all(
    kinds.map(async ({ kind, programKey }) => {
      const decisions = programKey ? specs.get(programKey) : undefined;
      const autonomy = decisions?.autonomy ?? ({ mode: 'fixed' } as const);
      const judged = await judgedDecisions(tx, tenantId, kind, programKey);
      const record = tallyRecord(judged, autonomy, decisions?.ceiling ?? {});
      return {
        kind,
        programKey,
        ...record,
        confidenceBps: Math.round(confidentScore(record) * 10_000),
        earnedShareBps: earnedShareBps(record, autonomy),
      };
    }),
  );
}
