import { applyBps, DealTerms, Mandate, mandateLimits } from '@novate/core';
import { deals, type Tx } from '@novate/db';
import type { ProgramSpec } from '@novate/policy';
import { and, eq, gte, isNotNull, ne, notInArray, sql } from 'drizzle-orm';
import { monthStart } from './calendar.ts';
import { type DealRow, getAgent, getMember } from './repo.ts';
import { tenantSettings } from './settings.ts';

type Role = 'buy' | 'sell';

/** Who takes a role in a deal: the buyer buys, the seller sells. */
const roleNoun = (role: Role) => (role === 'buy' ? 'buyer' : 'seller');

/** Extra legs are money the side pays on top of the deal, so they count against its limits. */
function legsPaidBy(deal: DealRow, terms: DealTerms, role: Role): bigint {
  const payer = roleNoun(role);
  const bps = terms.legs.filter((l) => l.payer === payer).reduce((acc, l) => acc + l.bps, 0);
  return applyBps(deal.amount, bps);
}

/**
 * Deals unwound since they passed authority. Settled deals are not here: what an agent committed
 * stays committed once it has settled.
 */
const UNWOUND = ['rejected', 'cancelled', 'refunded'] as const;

/**
 * What agents in a tenant have committed this month, per agent, side and currency: exactly what a
 * monthly limit is checked against. The month starts in the tenant's time zone. Narrow it to one
 * agent's side in one currency, and leave out the deal being checked.
 */
export async function committedThisMonth(
  db: Tx,
  tenantId: string,
  now: Date,
  scope: { agentId?: string; role?: Role; currency?: string; excludeDealId?: string } = {},
) {
  const since = monthStart(now, (await tenantSettings(db, tenantId)).timeZone);
  const side = (role: Role) => {
    const agentCol = role === 'buy' ? deals.buyerAgentId : deals.sellerAgentId;
    return db
      .select({
        agentId: agentCol,
        currency: deals.currency,
        amount: sql<string>`sum(${deals.amount})`,
        deals: sql<number>`count(*)::int`,
      })
      .from(deals)
      .where(
        and(
          eq(deals.tenantId, tenantId),
          scope.agentId ? eq(agentCol, scope.agentId) : isNotNull(agentCol),
          scope.currency ? eq(deals.currency, scope.currency) : undefined,
          scope.excludeDealId ? ne(deals.id, scope.excludeDealId) : undefined,
          gte(deals.createdAt, since),
          isNotNull(deals.authorityPassedAt),
          notInArray(deals.status, [...UNWOUND]),
        ),
      )
      .groupBy(agentCol, deals.currency)
      .then((rows) =>
        rows.map((r) => ({
          side: role,
          agentId: r.agentId as string,
          currency: r.currency,
          amount: BigInt(r.amount),
          deals: r.deals,
        })),
      );
  };
  const roles: Role[] = scope.role ? [scope.role] : ['buy', 'sell'];
  const rows: Awaited<ReturnType<typeof side>> = [];
  for (const role of roles) rows.push(...(await side(role)));
  return { since, rows };
}

/**
 * Was each agent allowed to make this deal? Checks the member is active and the agent's
 * mandate: role, currency, category, counterparty, per-deal and month-to-date limits.
 * Takes an advisory lock per agent and marks the deal as counted before the lock is released,
 * so concurrent deals cannot both squeeze under a limit.
 */
export async function checkAuthority(
  db: Tx,
  deal: DealRow,
  program: ProgramSpec,
  now: Date,
): Promise<string[]> {
  const failures: string[] = [];
  const terms = DealTerms.parse(deal.terms);
  const enforce = program.authority.enforceMandate;

  for (const memberId of [deal.buyerMemberId, deal.sellerMemberId]) {
    const m = await getMember(db, memberId);
    if (m.status !== 'active') failures.push(`member ${m.name} is ${m.status}`);
    if (m.tenantId !== deal.tenantId) failures.push(`member ${m.name} belongs to another tenant`);
  }

  const sides = [
    {
      agentId: deal.buyerAgentId,
      role: 'buy' as const,
      memberId: deal.buyerMemberId,
      other: deal.sellerMemberId,
    },
    {
      agentId: deal.sellerAgentId,
      role: 'sell' as const,
      memberId: deal.sellerMemberId,
      other: deal.buyerMemberId,
    },
  ];

  // A stable lock order, so two deals between the same agents cannot deadlock.
  sides.sort((a, b) => (a.agentId ?? '').localeCompare(b.agentId ?? ''));

  for (const side of sides) {
    if (!side.agentId) {
      if (enforce) failures.push(`no ${roleNoun(side.role)} agent named`);
      continue;
    }
    await db.execute(sql`SELECT pg_advisory_xact_lock(hashtext(${side.agentId}))`);
    const agent = await getAgent(db, side.agentId);
    const label = `${roleNoun(side.role)} agent ${agent.name}`;
    if (agent.status !== 'active') failures.push(`${label} is ${agent.status}`);
    if (agent.memberId !== side.memberId) failures.push(`${label} does not act for this member`);
    if (agent.tenantId !== deal.tenantId) failures.push(`${label} belongs to another tenant`);

    const parsed = Mandate.safeParse(agent.mandate);
    if (!parsed.success) {
      failures.push(`${label} has an invalid mandate`);
      continue;
    }
    const m = parsed.data;
    if (!m.roles.includes(side.role)) failures.push(`${label} may not ${side.role}`);
    if (m.categories && !m.categories.includes(terms.category)) {
      failures.push(`${label} may not deal in category ${terms.category}`);
    }
    if (m.counterparties && !m.counterparties.includes(side.other)) {
      failures.push(`${label} may not deal with this counterparty`);
    }
    const exposure = deal.amount + legsPaidBy(deal, terms, side.role);
    const limits = mandateLimits(m, deal.currency);
    if (!limits) {
      failures.push(`${label} may not deal in ${deal.currency}`);
      continue;
    }
    if (limits.maxPerDeal !== undefined && exposure > limits.maxPerDeal) {
      failures.push(
        `${label} per-deal limit ${limits.maxPerDeal} ${deal.currency} exceeded by ${exposure}`,
      );
    }
    if (limits.monthlyLimit !== undefined) {
      const { rows } = await committedThisMonth(db, deal.tenantId, now, {
        agentId: side.agentId,
        role: side.role,
        currency: deal.currency,
        excludeDealId: deal.id,
      });
      const spent = rows.reduce((acc, r) => acc + r.amount, 0n);
      if (spent + exposure > limits.monthlyLimit) {
        failures.push(
          `${label} monthly limit ${limits.monthlyLimit} ${deal.currency} exceeded (${spent} already committed)`,
        );
      }
    }
  }
  if (!failures.length) {
    await db.update(deals).set({ authorityPassedAt: now }).where(eq(deals.id, deal.id));
  }
  return failures;
}
