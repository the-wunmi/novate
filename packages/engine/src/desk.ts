import {
  cycles,
  fxConversions,
  members,
  obligations,
  reconRuns,
  settlementInstructions,
} from '@novate/db';
import { and, desc, eq, inArray, ne } from 'drizzle-orm';
import { deps } from './deps.ts';

const RECENT_CYCLES = 12;
/** A failed payout moved nothing, so it has no place in what actually moved. */
const MOVED: (typeof settlementInstructions.$inferSelect.status)[] = [
  'submitted',
  'in_doubt',
  'confirmed',
  'reversed',
];

/** What the console shows that no single table holds: netting, who holds what, and the books. */
export async function deskView(tenantId: string) {
  const { db, ledger } = deps();
  const [people, recent, runs, held, locked] = await Promise.all([
    db.select().from(members).where(eq(members.tenantId, tenantId)),
    db
      .select()
      .from(cycles)
      .where(and(eq(cycles.tenantId, tenantId), ne(cycles.status, 'netting')))
      .orderBy(desc(cycles.createdAt))
      .limit(RECENT_CYCLES),
    db
      .select()
      .from(reconRuns)
      .where(and(eq(reconRuns.tenantId, tenantId), ne(reconRuns.status, 'opening')))
      .orderBy(desc(reconRuns.createdAt))
      .limit(50),
    ledger.balances(db, tenantId, 'member:'),
    ledger.balances(db, tenantId, 'deal:'),
  ]);
  const ids = recent.map((c) => c.id);
  const [owed, paid, converted] = ids.length
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
      ])
    : [[], [], []];

  return {
    members: people.map((m) => ({
      id: m.id,
      name: m.name,
      homeCurrency: m.homeCurrency,
      available: held
        .filter((a) => a.code.startsWith(`member:${m.id}:`) && a.code.endsWith(':available'))
        .map((a) => ({ currency: a.currency, amount: a.balance })),
    })),
    lockedInDeals: totalByCurrency(locked),
    cycles: recent
      .map((c) => ({
        id: c.id,
        status: c.status,
        closedAt: c.closedAt,
        owed: owed
          .filter((o) => o.cycleId === c.id)
          .map((o) => ({
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
          })),
        converted: converted
          .filter((f) => f.cycleId === c.id)
          .map((f) => ({
            sellCurrency: f.sellCurrency,
            sellAmount: f.sellAmount,
            buyCurrency: f.buyCurrency,
            buyAmount: f.buyAmount,
          })),
      }))
      .filter((c) => c.owed.length),
    books: [...new Set(runs.map((r) => r.rail))].map((rail) => {
      const run = runs.find((r) => r.rail === rail) as (typeof runs)[number];
      return {
        rail,
        status: run.status,
        checkedAt: run.createdAt,
        differences: run.summary.breaks ?? 0,
      };
    }),
  };
}

function totalByCurrency(accounts: { currency: string; balance: bigint }[]) {
  const totals = new Map<string, bigint>();
  for (const a of accounts) totals.set(a.currency, (totals.get(a.currency) ?? 0n) + a.balance);
  return [...totals]
    .filter(([, amount]) => amount > 0n)
    .map(([currency, amount]) => ({ currency, amount }));
}
