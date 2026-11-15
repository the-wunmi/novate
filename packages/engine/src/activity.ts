import { parseInput } from '@novate/core';
import {
  controlEvents,
  cycles,
  dealEvents,
  deals,
  decisionCases,
  decisionRecords,
  ledgerAccounts,
  ledgerTransfers,
  reconRuns,
} from '@novate/db';
import { type ActionCheck, describeCheck } from '@novate/policy';
import { and, eq, getTableName, inArray, ne, notInArray, type SQL, sql } from 'drizzle-orm';
import { alias, type PgColumn } from 'drizzle-orm/pg-core';
import { z } from 'zod';
import { deps } from './deps.ts';
import { keyset, newestFirst, ofTenant, pageOf } from './page.ts';
import { inRange, Population, type Window } from './population.ts';
import type { DealEventType } from './repo.ts';
import { settlementOf } from './settlement-group.ts';

const FEED_SIZE = 80;

/** Bookkeeping events a person watching the house has no use for. */
const QUIET_EVENTS: DealEventType[] = ['locks_planned'];
/** The parts of an event payload worth showing. The rest can be large and is on the deal. */
const SHOWN_FIELDS = [
  'reason',
  'status',
  'state',
  'kind',
  'type',
  'source',
  'amount',
  'currency',
  'program',
  'side',
  'cycleId',
  'of',
  'forced',
] as const;
/** Money that arrives or leaves the house on its own, rather than as part of a deal's settlement. */
const MONEY_KINDS = ['deposit', 'deposit_reversal', 'rail_fee', 'withdrawal'];

/**
 * The money an event is about: its own amount where it records one, such as what was released or
 * paid, and otherwise the deal's. Amounts in a payload are stored as strings of minor units.
 */
function eventAmount(payload: Record<string, unknown>, dealAmount: bigint, dealCurrency: string) {
  const own = payload.amount;
  if (typeof own !== 'bigint' && !/^-?\d+$/.test(String(own ?? ''))) {
    return { amount: dealAmount, currency: dealCurrency };
  }
  const currency = typeof payload.currency === 'string' ? payload.currency : dealCurrency;
  return { amount: BigInt(own as string), currency };
}

const pick = (payload: Record<string, unknown>) =>
  Object.fromEntries(SHOWN_FIELDS.flatMap((k) => (k in payload ? [[k, payload[k]]] : [])));

/** The sources of activity, in the order rows written at the same moment are shown. */
const SOURCES = {
  event: { at: dealEvents.createdAt, id: dealEvents.seq },
  decision: { at: decisionRecords.createdAt, id: decisionRecords.id },
  money: { at: ledgerTransfers.createdAt, id: ledgerTransfers.id },
  cycle: { at: cycles.createdAt, id: cycles.id },
  recon: { at: reconRuns.createdAt, id: reconRuns.id },
  control: { at: controlEvents.createdAt, id: controlEvents.id },
} satisfies Record<string, { at: PgColumn; id: PgColumn }>;
type Source = keyof typeof SOURCES;
const RANK = Object.fromEntries(Object.keys(SOURCES).map((s, i) => [s, i])) as Record<
  Source,
  number
>;

/** The cursor of the activity feed: the previous page's last item, as `source:id`. */
const ActivityCursor = z
  .string()
  .regex(
    /^(event:\d+|(control|recon|cycle|money|decision):[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})$/i,
    'Not a cursor this feed returned',
  );
const ActivityWindow = Population.extend({ before: ActivityCursor.optional() });

/**
 * A source's rows that come after the cursor item in the merged order (`newerFirst`). Another
 * source's rows at the cursor's exact moment come after it only if that source is listed later.
 */
function pastCursor(tenantId: string, source: Source, before: string | undefined): SQL | undefined {
  if (!before) return undefined;
  const split = before.indexOf(':');
  const cursorSource = before.slice(0, split) as Source;
  const id = before.slice(split + 1);
  const own = SOURCES[source];
  if (cursorSource === source) return keyset(own.at, own.id, tenantId, id);
  const theirs = SOURCES[cursorSource];
  const at = sql`(select ${theirs.at} from ${sql.identifier(getTableName(theirs.at.table))} where ${theirs.id} = ${id} and ${ofTenant(theirs.at.table, tenantId)})`;
  return RANK[source] > RANK[cursorSource] ? sql`${own.at} <= ${at}` : sql`${own.at} < ${at}`;
}

/** A row's time to the microsecond, so rows from different sources merge in Postgres's order. */
const exactly = (at: PgColumn) =>
  sql<string>`to_char(${at} at time zone 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US')`;

/**
 * Everything that happened in the house, newest first: what agents did to deals, every decision and
 * who made it, money arriving, cycles and reconciliation. It is what shows the house running itself.
 */
export async function activityFeed(tenantId: string, input?: z.input<typeof ActivityWindow>) {
  const w = parseInput(ActivityWindow, input ?? {});
  return activityIn(tenantId, { ...w, limit: w.limit ?? FEED_SIZE });
}

/**
 * Activity in a window already decided, such as an export's. Each source reads one row past the
 * limit, so whatever the merge keeps, nothing newer from any source was left out.
 */
export async function activityIn(tenantId: string, w: Window) {
  const { db } = deps();
  const debit = alias(ledgerAccounts, 'debit');
  const read = w.limit + 1;
  const where = (source: Source) => [
    ...inRange(SOURCES[source].at, w),
    pastCursor(tenantId, source, w.before),
  ];
  const [events, decided, money, cycleRows, runs, controls] = await Promise.all([
    db
      .select({
        at: dealEvents.createdAt,
        exact: exactly(dealEvents.createdAt),
        seq: dealEvents.seq,
        type: dealEvents.type,
        payload: dealEvents.payload,
        dealId: dealEvents.dealId,
        buyer: deals.buyerMemberId,
        seller: deals.sellerMemberId,
        dealAmount: deals.amount,
        dealCurrency: deals.currency,
      })
      .from(dealEvents)
      .innerJoin(deals, eq(deals.id, dealEvents.dealId))
      .where(
        and(
          eq(deals.tenantId, tenantId),
          notInArray(dealEvents.type, QUIET_EVENTS),
          ...where('event'),
        ),
      )
      .orderBy(...newestFirst(dealEvents.createdAt, dealEvents.seq))
      .limit(read),
    db
      .select({
        at: decisionRecords.createdAt,
        exact: exactly(decisionRecords.createdAt),
        id: decisionRecords.id,
        decider: decisionRecords.deciderType,
        action: decisionRecords.action,
        accepted: decisionRecords.accepted,
        checks: decisionRecords.checks,
        caseId: decisionCases.id,
        caseKind: decisionCases.kind,
        dealId: decisionCases.dealId,
      })
      .from(decisionRecords)
      .innerJoin(decisionCases, eq(decisionCases.id, decisionRecords.caseId))
      .where(and(eq(decisionCases.tenantId, tenantId), ...where('decision')))
      .orderBy(...newestFirst(decisionRecords.createdAt, decisionRecords.id))
      .limit(read),
    db
      .select({
        at: ledgerTransfers.createdAt,
        exact: exactly(ledgerTransfers.createdAt),
        id: ledgerTransfers.id,
        kind: ledgerTransfers.kind,
        amount: ledgerTransfers.amount,
        currency: ledgerTransfers.currency,
        ref: ledgerTransfers.ref,
        // The member's side and the rail's side of money crossing the house's edge.
        memberId: sql<string | null>`coalesce(${ledgerAccounts.memberId}, ${debit.memberId})`,
        rail: sql<string | null>`coalesce(${ledgerAccounts.rail}, ${debit.rail})`,
      })
      .from(ledgerTransfers)
      .innerJoin(ledgerAccounts, eq(ledgerAccounts.id, ledgerTransfers.creditAccountId))
      .innerJoin(debit, eq(debit.id, ledgerTransfers.debitAccountId))
      .where(
        and(
          eq(ledgerTransfers.tenantId, tenantId),
          inArray(ledgerTransfers.kind, MONEY_KINDS),
          ...where('money'),
        ),
      )
      .orderBy(...newestFirst(ledgerTransfers.createdAt, ledgerTransfers.id))
      .limit(read),
    db
      .select({ c: cycles, exact: exactly(cycles.createdAt) })
      .from(cycles)
      .where(and(eq(cycles.tenantId, tenantId), ne(cycles.status, 'netting'), ...where('cycle')))
      .orderBy(...newestFirst(cycles.createdAt, cycles.id))
      .limit(read),
    db
      .select({ r: reconRuns, exact: exactly(reconRuns.createdAt) })
      .from(reconRuns)
      .where(
        and(eq(reconRuns.tenantId, tenantId), ne(reconRuns.status, 'opening'), ...where('recon')),
      )
      .orderBy(...newestFirst(reconRuns.createdAt, reconRuns.id))
      .limit(read),
    db
      .select({ e: controlEvents, exact: exactly(controlEvents.createdAt) })
      .from(controlEvents)
      .where(and(eq(controlEvents.tenantId, tenantId), ...where('control')))
      .orderBy(...newestFirst(controlEvents.createdAt, controlEvents.id))
      .limit(read),
  ]);

  const none = { dealId: null, caseId: null, amount: null, currency: null, actor: null };
  const items = [
    ...events.map((e) => ({
      id: `event:${e.seq}`,
      key: { exact: e.exact, source: 'event' as const, id: e.seq },
      at: e.at,
      source: 'deal' as const,
      type: e.type,
      ...none,
      dealId: e.dealId,
      ...eventAmount(e.payload, e.dealAmount, e.dealCurrency),
      detail: { buyer: e.buyer, seller: e.seller, event: pick(e.payload) },
    })),
    ...decided.map((d) => ({
      id: `decision:${d.id}`,
      key: { exact: d.exact, source: 'decision' as const, id: d.id },
      at: d.at,
      source: 'decision' as const,
      type: d.action.type,
      ...none,
      dealId: d.dealId,
      caseId: d.caseId,
      detail: {
        decider: d.decider,
        accepted: d.accepted === 1,
        failed: (d.checks as ActionCheck[])
          .filter((c) => !c.passed)
          .map((c) => ({ ...c, text: describeCheck(c) })),
        caseKind: d.caseKind,
      },
    })),
    ...money.map((m) => ({
      id: `money:${m.id}`,
      key: { exact: m.exact, source: 'money' as const, id: m.id },
      at: m.at,
      source: 'money' as const,
      type: m.kind,
      ...none,
      amount: m.amount,
      currency: m.currency,
      detail: { ref: m.ref, memberId: m.memberId, rail: m.rail },
    })),
    ...cycleRows.map(({ c, exact }) => ({
      id: `cycle:${c.id}`,
      key: { exact, source: 'cycle' as const, id: c.id },
      at: c.createdAt,
      source: 'cycle' as const,
      type: c.status,
      ...none,
      detail: {
        cycleId: c.id,
        closedAt: c.closedAt,
        rail: settlementOf(c.settlementGroup)?.rail ?? null,
      },
    })),
    ...runs.map(({ r, exact }) => ({
      id: `recon:${r.id}`,
      key: { exact, source: 'recon' as const, id: r.id },
      at: r.createdAt,
      source: 'recon' as const,
      type: r.status,
      ...none,
      detail: { rail: r.rail, differences: r.breakCount },
    })),
    ...controls.map(({ e, exact }) => ({
      id: `control:${e.id}`,
      key: { exact, source: 'control' as const, id: e.id },
      at: e.createdAt,
      source: 'control' as const,
      type: e.type,
      ...none,
      actor: e.actor,
      detail: { reason: e.reason, payload: e.payload },
    })),
  ];
  const merged = items.sort((a, b) => newerFirst(a.key, b.key)).map(({ key, ...item }) => item);
  return pageOf(merged, w.limit, (item) => item.id);
}

interface MergeKey {
  exact: string;
  source: Source;
  id: string | bigint;
}

/** The merged feed's order: newest first, then by source as `SOURCES` lists them, then newest id. */
function newerFirst(a: MergeKey, b: MergeKey): number {
  if (a.exact !== b.exact) return a.exact < b.exact ? 1 : -1;
  if (a.source !== b.source) return RANK[a.source] - RANK[b.source];
  if (a.id === b.id) return 0;
  return a.id < b.id ? 1 : -1;
}
