import { type Db, dealEvents, deals, settlementInstructions } from '@novate/db';
import type { SignalProvider, SignalSubject } from '@novate/signals';
import { and, eq, inArray, ne, notInArray, sql } from 'drizzle-orm';

const LIVE = ['submitted', 'rejected', 'cancelled', 'refunded'] as const;

/**
 * Built-in `history` signal: what the clearing house already knows about the parties.
 * Exposed to rules as `signals.history.{buyerAgent,buyer,seller}.*` (all doubles).
 */
export class HistorySignalProvider implements SignalProvider {
  readonly name = 'history';

  constructor(private readonly db: () => Db) {}

  async resolve(s: SignalSubject) {
    const db = this.db();
    const excludeSelf = s.dealId ? ne(deals.id, s.dealId) : undefined;

    const buyerAgent = s.buyerAgentId
      ? await db
          .select({
            dealCount: sql<number>`count(*)::float8`,
            medianQuantity: sql<number>`coalesce(percentile_cont(0.5) within group (order by ${deals.quantity}), 0)::float8`,
            medianAmount: sql<number>`coalesce(percentile_cont(0.5) within group (order by ${deals.amount}), 0)::float8`,
          })
          .from(deals)
          .where(
            and(
              eq(deals.buyerAgentId, s.buyerAgentId),
              notInArray(deals.status, [...LIVE]),
              excludeSelf,
            ),
          )
          .then((r) => r[0])
      : undefined;

    const [buyer] = await db
      .select({ completedDeals: sql<number>`count(*)::float8` })
      .from(deals)
      .where(and(eq(deals.buyerMemberId, s.buyerMemberId), eq(deals.status, 'settled')));
    const [buyerDefaults] = await db
      .select({ defaults: sql<number>`count(*)::float8` })
      .from(settlementInstructions)
      .where(
        and(
          eq(settlementInstructions.memberId, s.buyerMemberId),
          eq(settlementInstructions.direction, 'collect'),
          eq(settlementInstructions.status, 'failed'),
        ),
      );

    const sellerDeals = await db
      .select({ id: deals.id, amount: deals.amount, releaseAmount: deals.releaseAmount })
      .from(deals)
      .where(and(eq(deals.sellerMemberId, s.sellerMemberId), eq(deals.status, 'settled')));
    const late = sellerDeals.length
      ? await db
          .select({ n: sql<number>`count(distinct ${dealEvents.dealId})::float8` })
          .from(dealEvents)
          .where(
            and(
              inArray(
                dealEvents.dealId,
                sellerDeals.map((d) => d.id),
              ),
              eq(dealEvents.type, 'released'),
              sql`${dealEvents.payload}->>'late' = 'true'`,
            ),
          )
          .then((r) => r[0]?.n ?? 0)
      : 0;
    const shortfall = sellerDeals.reduce(
      (acc, d) => acc + (1 - Number(d.releaseAmount ?? d.amount) / Number(d.amount)),
      0,
    );

    return {
      buyerAgent: {
        dealCount: buyerAgent?.dealCount ?? 0,
        medianQuantity: buyerAgent?.medianQuantity ?? 0,
        medianAmount: buyerAgent?.medianAmount ?? 0,
      },
      buyer: { completedDeals: buyer?.completedDeals ?? 0, defaults: buyerDefaults?.defaults ?? 0 },
      seller: {
        completedDeals: sellerDeals.length,
        onTimeRate: sellerDeals.length ? 1 - late / sellerDeals.length : 1,
        defectRate: sellerDeals.length ? shortfall / sellerDeals.length : 0,
      },
    };
  }
}
