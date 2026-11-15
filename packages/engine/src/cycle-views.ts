import { type Currency, parseInput } from '@novate/core';
import {
  cycles,
  fxConversions,
  obligations,
  rowHistory,
  settlementInstructions,
  type Tx,
} from '@novate/db';
import { type NettingMode, net } from '@novate/netting';
import {
  and,
  countDistinct,
  desc,
  eq,
  gte,
  inArray,
  isNotNull,
  lt,
  min,
  ne,
  or,
  sql,
} from 'drizzle-orm';
import { z } from 'zod';
import { deps } from './deps.ts';
import { rateLabel } from './rates.ts';
import { latestAttempt } from './repo.ts';
import { settlementOf } from './settlement-group.ts';

const RECENT_CYCLES = 30;

/**
 * When the rail confirmed each payment, from the history every change to an instruction leaves:
 * the first time its status became `confirmed`. Not `updatedAt`, which moves again if a paid
 * payment is later returned.
 */
export async function paidAtOf(db: Pick<Tx, 'select'>, instructionIds: string[]) {
  if (!instructionIds.length) return new Map<string, Date>();
  const rows = await db
    .select({ id: rowHistory.rowId, at: min(rowHistory.at) })
    .from(rowHistory)
    .where(
      and(
        eq(rowHistory.tableName, 'settlement_instructions'),
        inArray(rowHistory.rowId, instructionIds),
        sql`${rowHistory.new}->>'status' = 'confirmed'`,
        sql`${rowHistory.old}->>'status' <> 'confirmed'`,
      ),
    )
    .groupBy(rowHistory.rowId);
  return new Map(rows.flatMap((r) => (r.at ? [[r.id, new Date(r.at)] as const] : [])));
}

/** A failed payout moved nothing, so it has no place in what actually moved. */
const MOVED: (typeof settlementInstructions.$inferSelect.status)[] = [
  'submitted',
  'in_doubt',
  'confirmed',
  'reversed',
];

/** Each cycle with what was owed in it, the payouts that moved and the conversions it booked. */
export async function cycleViews(db: Pick<Tx, 'select'>, rows: (typeof cycles.$inferSelect)[]) {
  const ids = rows.map((c) => c.id);
  const [owed, paid, converted, failed] = ids.length
    ? await Promise.all([
        db.select().from(obligations).where(inArray(obligations.cycleId, ids)),
        db
          .select()
          .from(settlementInstructions)
          .where(
            and(
              inArray(settlementInstructions.cycleId, ids),
              eq(settlementInstructions.direction, 'payout'),
              inArray(settlementInstructions.status, MOVED),
            ),
          ),
        db.select().from(fxConversions).where(inArray(fxConversions.cycleId, ids)),
        db
          .select()
          .from(settlementInstructions)
          .where(
            and(
              inArray(settlementInstructions.cycleId, ids),
              eq(settlementInstructions.direction, 'payout'),
              eq(settlementInstructions.status, 'failed'),
              latestAttempt(db as Tx),
            ),
          ),
      ])
    : [[], [], [], []];
  const paidAt = await paidAtOf(
    db,
    paid.map((p) => p.id),
  );
  return rows.map((c) => ({
    id: c.id,
    kind: c.kind,
    status: c.status,
    settlement: settlementOf(c.settlementGroup),
    createdAt: c.createdAt,
    closedAt: c.closedAt,
    owed: owed
      .filter((o) => o.cycleId === c.id)
      .map((o) => ({
        dealId: o.dealId,
        payer: o.payerMemberId,
        payee: o.payeeMemberId,
        amount: o.amount,
        currency: o.currency,
      })),
    paid: paid
      .filter((p) => p.cycleId === c.id)
      .map((p) => ({
        memberId: p.memberId,
        amount: p.amount,
        currency: p.currency,
        status: p.status,
        rail: p.rail,
        externalRef: p.externalRef,
        failureReason: p.failureReason,
        paidAt: paidAt.get(p.id) ?? null,
      })),
    /** Payouts whose latest attempt failed, and whether the money has gone to the member's wallet. */
    failed: failed
      .filter((p) => p.cycleId === c.id)
      .map((p) => ({
        memberId: p.memberId,
        amount: p.amount,
        currency: p.currency,
        rail: p.rail,
        failureReason: p.failureReason,
        returnedToWallet: p.returnedToWalletAt !== null,
      })),
    converted: converted
      .filter((f) => f.cycleId === c.id)
      .map((f) => ({
        sellCurrency: f.sellCurrency,
        sellAmount: f.sellAmount,
        buyCurrency: f.buyCurrency,
        buyAmount: f.buyAmount,
        externalRef: f.externalRef,
        rateLabel: rateLabel(f.sellCurrency, f.buyCurrency, f.rateE8),
      })),
  }));
}

/**
 * A cycle that failed before commit or was held back gave its obligations back to the queue, so it
 * has none left: its status alone says it ran.
 */
const STOPPED: (typeof cycles.$inferSelect.status)[] = ['failed', 'deferred'];

/** The latest settlement cycles that had something to settle or stopped, newest first. */
export async function recentCycles(tenantId: string) {
  const { db } = deps();
  const recent = await db
    .select()
    .from(cycles)
    .where(
      and(
        eq(cycles.tenantId, tenantId),
        eq(cycles.kind, 'settlement'),
        ne(cycles.status, 'netting'),
      ),
    )
    .orderBy(desc(cycles.createdAt), desc(cycles.id))
    .limit(RECENT_CYCLES);
  return (await cycleViews(db, recent)).filter((c) => c.owed.length || STOPPED.includes(c.status));
}

export const PeriodQuery = z.object({
  /** Start of the period, inclusive. */
  from: z.coerce.date().optional(),
  /** End of the period, exclusive. */
  to: z.coerce.date().optional(),
});

/**
 * Settlement cycles started in a period: how many and how each stands, and per currency what was
 * owed gross, what the cycles' net positions paid out in that same currency before any conversion,
 * and what netting offset. Gross groups net nothing by design, so they are left out of the netting
 * figures.
 */
export async function settlementSummary(tenantId: string, input: z.input<typeof PeriodQuery> = {}) {
  const { from, to } = parseInput(PeriodQuery, input);
  const { db } = deps();
  const period = and(
    eq(cycles.tenantId, tenantId),
    eq(cycles.kind, 'settlement'),
    from ? gte(cycles.createdAt, from) : undefined,
    to ? lt(cycles.createdAt, to) : undefined,
  );
  const [statuses, owed] = await Promise.all([
    db
      .select({ status: cycles.status, n: countDistinct(cycles.id) })
      .from(cycles)
      .leftJoin(obligations, eq(obligations.cycleId, cycles.id))
      .where(and(period, or(isNotNull(obligations.id), inArray(cycles.status, STOPPED))))
      .groupBy(cycles.status),
    db
      .select({
        cycleId: cycles.id,
        group: cycles.settlementGroup,
        id: obligations.id,
        payer: obligations.payerMemberId,
        payee: obligations.payeeMemberId,
        currency: obligations.currency,
        amount: obligations.amount,
      })
      .from(obligations)
      .innerJoin(cycles, eq(cycles.id, obligations.cycleId))
      .where(period),
  ]);
  const byCycle = new Map<string, { mode: NettingMode; rows: typeof owed }>();
  for (const o of owed) {
    const mode = settlementOf(o.group)?.netting as NettingMode | undefined;
    if (!mode || mode === 'gross') continue;
    const found = byCycle.get(o.cycleId) ?? { mode, rows: [] };
    found.rows.push(o);
    byCycle.set(o.cycleId, found);
  }
  const netting = new Map<
    string,
    { currency: string; cycles: number; owed: bigint; paid: bigint }
  >();
  for (const { mode, rows } of byCycle.values()) {
    const result = net(
      rows.flatMap((o) =>
        o.amount > 0n ? [{ ...o, currency: o.currency as Currency, prefunded: 0n }] : [],
      ),
      mode,
    );
    for (const [currency, t] of Object.entries(result.totals)) {
      const row = netting.get(currency) ?? { currency, cycles: 0, owed: 0n, paid: 0n };
      row.cycles += 1;
      row.owed += t.gross;
      netting.set(currency, row);
    }
    for (const p of result.positions) {
      const row = netting.get(p.currency);
      if (row) row.paid += p.payout;
    }
  }
  return {
    from: from ?? null,
    to: to ?? null,
    /** Cycles that had something to settle or stopped, by status. */
    cycles: Object.fromEntries(statuses.map((s) => [s.status, s.n])) as Record<string, number>,
    netting: [...netting.values()]
      .map((r) => ({ ...r, netted: r.owed - r.paid }))
      .sort((a, b) => (b.owed > a.owed ? 1 : b.owed < a.owed ? -1 : 0)),
  };
}
