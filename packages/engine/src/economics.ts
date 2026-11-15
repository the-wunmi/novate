import { parseInput } from '@novate/core';
import { cycles, deals, ledgerAccounts, ledgerTransfers, obligations, programs } from '@novate/db';
import { PROGRAM_FEE_KINDS } from '@novate/ledger';
import type { ProgramSpec } from '@novate/policy';
import { railLabel } from '@novate/rails';
import {
  type AnyColumn,
  and,
  count,
  eq,
  gte,
  inArray,
  isNotNull,
  lt,
  type SQL,
  sql,
} from 'drizzle-orm';
import { type PgSelect, unionAll } from 'drizzle-orm/pg-core';
import { z } from 'zod';
import { businessDay, monthStart } from './calendar.ts';
import { moneyColumns } from './csv.ts';
import { deps } from './deps.ts';
import { type CsvExport, exportCsv, exportRange } from './population.ts';
import { readTenantSettings } from './settings.ts';

export const EconomicsQuery = z.object({
  /** Start of the period, inclusive. */
  from: z.coerce.date().optional(),
  /** End of the period, exclusive. */
  to: z.coerce.date().optional(),
});

const FEE_KINDS = {
  railFeesPaid: ['rail_fee'],
  cardFees: ['card_fee', 'card_fee_shortfall'],
} as const;

const total = sql<string>`sum(${obligations.amount})`;

/** Obligations settled by a cycle that closed in the period, whenever the deal was opened. */
const settledIn = (tenantId: string, from?: Date, to?: Date) =>
  and(
    eq(obligations.tenantId, tenantId),
    eq(obligations.status, 'settled'),
    eq(cycles.status, 'settled'),
    from ? gte(cycles.closedAt, from) : undefined,
    to ? lt(cycles.closedAt, to) : undefined,
  );

/** A select from obligations, narrowed to those settled by a cycle and joined to it. */
const settledOnly = <Q extends PgSelect>(query: Q, where: SQL | undefined) =>
  query.innerJoin(cycles, eq(cycles.id, obligations.cycleId)).where(where);

/** Months in the `byMonth` series, ending with the one `to` falls in. */
const MONTHS = 12;

/** The starts of the `MONTHS` calendar months to the one `end` falls in, in `timeZone`, oldest first. */
function monthStarts(end: Date, timeZone: string) {
  const starts = [monthStart(end, timeZone)];
  while (starts.length < MONTHS) {
    const later = starts[0] as Date;
    starts.unshift(monthStart(new Date(later.getTime() - 43_200_000), timeZone));
  }
  return starts;
}

type Amounts = { currency: string; amount: bigint }[];

const addTo = (list: Amounts, currency: string, amount: bigint) => {
  const found = list.find((a) => a.currency === currency);
  if (found) found.amount += amount;
  else list.push({ currency, amount });
};

/**
 * The last twelve months to `end`, by calendar month in the tenant's zone: settled value per currency and deals
 * settled, by the close of the cycle that settled them, and platform fees charged, collected or owed.
 */
async function monthlySeries(tenantId: string, end: Date) {
  const { db } = deps();
  const { timeZone } = await readTenantSettings(tenantId);
  const starts = monthStarts(end, timeZone);
  const start = starts[0] as Date;
  // A literal, not a parameter, so the grouped expression is the selected one.
  const zone = sql.raw(`'${timeZone.replaceAll("'", "''")}'`);
  const closedMonth = sql<string>`to_char(${cycles.closedAt} at time zone ${zone}, 'YYYY-MM')`;
  const feeMonth = sql<string>`to_char(${ledgerTransfers.createdAt} at time zone ${zone}, 'YYYY-MM')`;
  const settled = settledIn(tenantId, start, end);
  const [value, dealCounts, fees] = await Promise.all([
    settledOnly(
      db
        .select({ month: closedMonth, currency: obligations.currency, amount: total })
        .from(obligations)
        .$dynamic(),
      settled,
    ).groupBy(closedMonth, obligations.currency),
    settledOnly(
      db
        .select({
          month: closedMonth,
          deals: sql<number>`count(distinct ${obligations.dealId})::int`,
        })
        .from(obligations)
        .$dynamic(),
      settled,
    ).groupBy(closedMonth),
    db
      .select({
        month: feeMonth,
        currency: ledgerTransfers.currency,
        amount: sql<string>`sum(${ledgerTransfers.amount})`,
      })
      .from(ledgerTransfers)
      .where(
        and(
          eq(ledgerTransfers.tenantId, tenantId),
          inArray(ledgerTransfers.kind, PROGRAM_FEE_KINDS),
          gte(ledgerTransfers.createdAt, start),
          lt(ledgerTransfers.createdAt, end),
        ),
      )
      .groupBy(feeMonth, ledgerTransfers.currency),
  ]);
  return starts.map((at) => {
    const month = businessDay(at, timeZone).date.slice(0, 7);
    return {
      month,
      settled: sumByCurrency(value.filter((v) => v.month === month)),
      dealsSettled: dealCounts.find((d) => d.month === month)?.deals ?? 0,
      fees: sumByCurrency(fees.filter((f) => f.month === month)),
    };
  });
}

/** The tenant and period every part of the economics report is read for. */
interface Period {
  tenantId: string;
  from?: Date;
  to?: Date;
}

const inPeriod = ({ from, to }: Period, column: AnyColumn) =>
  and(from ? gte(column, from) : undefined, to ? lt(column, to) : undefined);

const sumByCurrency = (rows: { currency: string; amount: string }[]): Amounts => {
  const out: Amounts = [];
  for (const r of rows) addTo(out, r.currency, BigInt(r.amount));
  return out;
};

/** Fees charged and paid in the period, by who earned or bore them. */
async function feeBreakdown(period: Period) {
  const fees = await deps()
    .db.select({
      kind: ledgerTransfers.kind,
      currency: ledgerTransfers.currency,
      amount: sql<string>`sum(${ledgerTransfers.amount})`,
    })
    .from(ledgerTransfers)
    .where(
      and(
        eq(ledgerTransfers.tenantId, period.tenantId),
        inArray(ledgerTransfers.kind, [...PROGRAM_FEE_KINDS, ...Object.values(FEE_KINDS).flat()]),
        inPeriod(period, ledgerTransfers.createdAt),
      ),
    )
    .groupBy(ledgerTransfers.kind, ledgerTransfers.currency);
  const totals = (kinds: readonly string[]) =>
    sumByCurrency(fees.filter((f) => kinds.includes(f.kind)));
  return {
    /** Fees taken from what members were paid or held. */
    feesCollected: totals(['platform_fee', 'house_fee']),
    /** Fees members could not pay at the time, booked as their debt to the house. */
    feesOwed: totals(['platform_fee_debt', 'house_fee_debt']),
    /** The platform's share of fees collected, by the program's `fees.platformShareBps`. */
    platformEarned: totals(['platform_fee']),
    /** The platform's share of fees members still owe. */
    platformOwed: totals(['platform_fee_debt']),
    /** The house's share of fees collected. */
    houseEarned: totals(['house_fee']),
    /** The house's share of fees members still owe. */
    houseOwed: totals(['house_fee_debt']),
    /** Rail fees the house paid out of its own money. */
    railFeesPaid: totals(FEE_KINDS.railFeesPaid),
    /** Card processing fees, charged to the buyers who paid by card, not a cost of the house. */
    cardFees: totals(FEE_KINDS.cardFees),
  };
}

/** Value settled per currency, and how many deals it settled. */
async function settledVolume(period: Period) {
  const { db } = deps();
  const settled = settledIn(period.tenantId, period.from, period.to);
  const [byCurrency, settledDeals] = await Promise.all([
    settledOnly(
      db
        .select({ currency: obligations.currency, amount: total, obligations: count() })
        .from(obligations)
        .$dynamic(),
      settled,
    ).groupBy(obligations.currency),
    settledOnly(
      db
        .select({ deals: sql<number>`count(distinct ${obligations.dealId})::int` })
        .from(obligations)
        .$dynamic(),
      settled,
    ),
  ]);
  return {
    byCurrency: byCurrency.map((v) => ({
      currency: v.currency,
      amount: BigInt(v.amount),
      obligations: v.obligations,
    })),
    deals: settledDeals[0]?.deals ?? 0,
  };
}

/** Each member in each currency: what it paid and received, its settled deals and its fees. */
async function memberRollup(period: Period) {
  const { db } = deps();
  const settled = settledIn(period.tenantId, period.from, period.to);
  // Each member once as payer and once as payee of every settled obligation.
  const party = (member: AnyColumn, role: 'paid' | 'received') =>
    db
      .select({
        memberId: sql<string>`${member}`.as('member_id'),
        currency: obligations.currency,
        dealId: obligations.dealId,
        leg: obligations.leg,
        paid: sql<string>`${role === 'paid' ? obligations.amount : sql`0`}`.as('paid'),
        received: sql<string>`${role === 'received' ? obligations.amount : sql`0`}`.as('received'),
      })
      .from(obligations)
      .$dynamic();
  const parties = unionAll(
    settledOnly(party(obligations.payerMemberId, 'paid'), settled),
    settledOnly(party(obligations.payeeMemberId, 'received'), settled),
  ).as('parties');
  const [byMember, memberFees] = await Promise.all([
    db
      .select({
        memberId: parties.memberId,
        currency: parties.currency,
        paid: sql<string>`sum(${parties.paid})`,
        received: sql<string>`sum(${parties.received})`,
        deals: sql<number>`(count(distinct ${parties.dealId}) filter (where ${parties.leg} = 'principal'))::int`,
      })
      .from(parties)
      .groupBy(parties.memberId, parties.currency),
    db
      .select({
        /** Who paid it: the member whose cycle position, wallet or debt it was taken from. */
        memberId: ledgerAccounts.memberId,
        currency: ledgerTransfers.currency,
        amount: sql<string>`sum(${ledgerTransfers.amount})`,
      })
      .from(ledgerTransfers)
      .innerJoin(ledgerAccounts, eq(ledgerAccounts.id, ledgerTransfers.debitAccountId))
      .where(
        and(
          eq(ledgerTransfers.tenantId, period.tenantId),
          inArray(ledgerTransfers.kind, PROGRAM_FEE_KINDS),
          inPeriod(period, ledgerTransfers.createdAt),
          isNotNull(ledgerAccounts.memberId),
        ),
      )
      .groupBy(ledgerAccounts.memberId, ledgerTransfers.currency),
  ]);

  const rows = new Map<
    string,
    {
      memberId: string;
      currency: string;
      paid: bigint;
      received: bigint;
      /** Deals it was a party to that settled in the period, by cycle close. */
      deals: number;
      /** Platform fees charged to it in the period, collected or owed. */
      fees: bigint;
    }
  >();
  const row = (memberId: string, currency: string) => {
    const key = `${memberId}:${currency}`;
    const found = rows.get(key) ?? {
      memberId,
      currency,
      paid: 0n,
      received: 0n,
      deals: 0,
      fees: 0n,
    };
    rows.set(key, found);
    return found;
  };
  for (const m of byMember) {
    Object.assign(row(m.memberId, m.currency), {
      paid: BigInt(m.paid),
      received: BigInt(m.received),
      deals: m.deals,
    });
  }
  for (const f of memberFees) row(f.memberId as string, f.currency).fees += BigInt(f.amount);
  return [...rows.values()];
}

/** Each program version in each currency: value and deals settled, and deals opened. */
async function programRollup(period: Period) {
  const { db } = deps();
  const [byProgram, openedByProgram] = await Promise.all([
    settledOnly(
      db
        .select({
          programId: deals.programId,
          currency: obligations.currency,
          amount: total,
          deals: sql<number>`count(distinct ${obligations.dealId})::int`,
        })
        .from(obligations)
        .innerJoin(deals, eq(deals.id, obligations.dealId))
        .$dynamic(),
      settledIn(period.tenantId, period.from, period.to),
    ).groupBy(deals.programId, obligations.currency),
    db
      .select({ programId: deals.programId, currency: deals.currency, deals: count() })
      .from(deals)
      .where(and(eq(deals.tenantId, period.tenantId), inPeriod(period, deals.createdAt)))
      .groupBy(deals.programId, deals.currency),
  ]);
  const programIds = [...new Set([...byProgram, ...openedByProgram].map((p) => p.programId))];
  const programRows = programIds.length
    ? await db
        .select({
          id: programs.id,
          key: programs.key,
          version: programs.version,
          spec: programs.spec,
        })
        .from(programs)
        .where(inArray(programs.id, programIds))
    : [];

  const rows = new Map<
    string,
    {
      programId: string;
      programKey: string;
      version: number;
      rail: string;
      label: string;
      currency: string;
      amount: bigint;
      /** Settled in the period: a cycle that closed in it settled the deal's obligations. */
      dealsSettled: number;
      /** Opened in the period: created in it, whatever happened since. */
      dealsOpened: number;
    }
  >();
  const row = (programId: string, currency: string) => {
    const key = `${programId}:${currency}`;
    const found = rows.get(key);
    if (found) return found;
    const p = programRows.find((r) => r.id === programId);
    if (!p) throw new Error(`Program ${programId} is referenced but missing`);
    const spec = p.spec as ProgramSpec;
    const rail = spec.settlement.rail;
    const entry = {
      programId,
      programKey: p.key,
      version: p.version,
      rail,
      label: `${spec.name} (${railLabel(rail)})`,
      currency,
      amount: 0n,
      dealsSettled: 0,
      dealsOpened: 0,
    };
    rows.set(key, entry);
    return entry;
  };
  for (const v of byProgram) {
    const e = row(v.programId, v.currency);
    e.amount += BigInt(v.amount);
    e.dealsSettled += v.deals;
  }
  for (const o of openedByProgram) row(o.programId, o.currency).dealsOpened += o.deals;
  return [...rows.values()];
}

/** Deals created in the period, by where each stands now. */
async function dealsOpened(period: Period) {
  return deps()
    .db.select({ status: deals.status, deals: count() })
    .from(deals)
    .where(and(eq(deals.tenantId, period.tenantId), inPeriod(period, deals.createdAt)))
    .groupBy(deals.status);
}

/**
 * What the house earned and spent, and how much it settled, in a period: platform fees earned,
 * rail fees paid, card fees members paid, settled volume per currency, program and member, and
 * how many deals were opened and settled.
 */
export async function economics(tenantId: string, input: z.input<typeof EconomicsQuery> = {}) {
  const { from, to } = parseInput(EconomicsQuery, input);
  const period: Period = { tenantId, from, to };
  const [fees, settled, byProgram, byMember, opened, byMonth] = await Promise.all([
    feeBreakdown(period),
    settledVolume(period),
    programRollup(period),
    memberRollup(period),
    dealsOpened(period),
    monthlySeries(tenantId, to ?? new Date()),
  ]);
  return {
    period: { from: from ?? null, to: to ?? null },
    ...fees,
    volume: { byCurrency: settled.byCurrency, byProgram, byMember },
    /** The last twelve months in the tenant's zone to `to`, or to now, oldest first, whatever `from` says. */
    byMonth,
    deals: {
      /** Created in the period. */
      opened: opened.reduce((acc, d) => acc + d.deals, 0),
      /** The deals opened in the period, by where each stands now. */
      byStatus: Object.fromEntries(opened.map((d) => [d.status, d.deals])),
      /** Settled in the period, by the close of the cycle that settled them, whenever opened. */
      settled: settled.deals,
      dates: { opened: 'deal created', byStatus: 'deal created', settled: 'cycle closed' },
    },
  };
}

/** One spreadsheet row: a program or member in a currency, or a fee or cost total. */
interface EconomicsLine {
  scope: string;
  id?: string;
  label?: string;
  currency: string;
  volume?: bigint;
  paid?: bigint;
  received?: bigint;
  dealsOpened?: number;
  dealsSettled?: number;
  fees?: bigint;
}

const money = (column: string, pick: (l: EconomicsLine) => bigint | undefined) =>
  moneyColumns<EconomicsLine>(column, pick, (l) => l.currency);

/**
 * The period's economics for a spreadsheet: one row per program and currency, one per member and
 * currency, then the fee and cost totals, each with the period.
 */
export async function economicsCsv(
  tenantId: string,
  input?: { from?: unknown; to?: unknown },
): Promise<CsvExport> {
  const { range } = exportRange(input);
  const report = await economics(tenantId, { from: range.from, to: range.to });
  const lines: EconomicsLine[] = [
    ...report.volume.byProgram.map((p) => ({
      scope: 'program',
      id: `${p.programKey}@v${p.version}`,
      label: p.label,
      currency: p.currency,
      volume: p.amount,
      dealsOpened: p.dealsOpened,
      dealsSettled: p.dealsSettled,
    })),
    ...report.volume.byMember.map((m) => ({
      scope: 'member',
      id: m.memberId,
      currency: m.currency,
      paid: m.paid,
      received: m.received,
      dealsSettled: m.deals,
      fees: m.fees,
    })),
    ...(
      [
        ['fees_collected', report.feesCollected],
        ['fees_owed', report.feesOwed],
        ['rail_fees_paid', report.railFeesPaid],
        ['card_fees', report.cardFees],
      ] as const
    ).flatMap(([scope, amounts]) =>
      amounts.map((a) => ({ scope, currency: a.currency, fees: a.amount })),
    ),
  ];
  return exportCsv<EconomicsLine>(
    [
      ['period_from', () => range.from],
      ['period_to', () => range.to],
      ['scope', (l) => l.scope],
      ['id', (l) => l.id],
      ['label', (l) => l.label],
      ['currency', (l) => l.currency],
      ...money('volume', (l) => l.volume),
      ...money('paid', (l) => l.paid),
      ...money('received', (l) => l.received),
      ['deals_opened', (l) => l.dealsOpened],
      ['deals_settled', (l) => l.dealsSettled],
      ...money('fees', (l) => l.fees),
    ],
    lines,
    range,
  );
}
