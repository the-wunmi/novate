import { applyBps, DealTerms, Mandate } from '@novate/core';
import { deals, type Tx } from '@novate/db';
import type { ProgramSpec } from '@novate/policy';
import { and, eq, gte, isNotNull, ne, notInArray, sql } from 'drizzle-orm';
import { type DealRow, getAgent, getMember } from './repo.ts';

/**
 * Was each agent allowed to make this deal? Checks the member is active and the agent's
 * mandate: role, currency, category, counterparty, per-deal and month-to-date limits.
 * Takes an advisory lock per agent and marks the deal as counted before the lock is released,
 * so concurrent deals cannot both squeeze under a limit.
 */
/** Extra legs are money the side pays on top of the deal, so they count against its limits. */
function legsPaidBy(deal: DealRow, terms: DealTerms, role: 'buy' | 'sell'): bigint {
  const payer = role === 'buy' ? 'buyer' : 'seller';
  const bps = terms.legs.filter((l) => l.payer === payer).reduce((acc, l) => acc + l.bps, 0);
  return applyBps(deal.amount, bps);
}

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
      if (enforce) failures.push(`no ${side.role === 'buy' ? 'buyer' : 'seller'} agent named`);
      continue;
    }
    await db.execute(sql`SELECT pg_advisory_xact_lock(hashtext(${side.agentId}))`);
    const agent = await getAgent(db, side.agentId);
    const label = `${side.role === 'buy' ? 'buyer' : 'seller'} agent ${agent.name}`;
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
    if (!m.currencies.includes(deal.currency))
      failures.push(`${label} may not deal in ${deal.currency}`);
    if (m.categories && !m.categories.includes(terms.category)) {
      failures.push(`${label} may not deal in category ${terms.category}`);
    }
    if (m.counterparties && !m.counterparties.includes(side.other)) {
      failures.push(`${label} may not deal with this counterparty`);
    }
    const exposure = deal.amount + legsPaidBy(deal, terms, side.role);
    if (m.maxPerDeal !== undefined && exposure > m.maxPerDeal) {
      failures.push(`${label} per-deal limit ${m.maxPerDeal} exceeded by ${exposure}`);
    }
    if (m.monthlyLimit !== undefined) {
      const monthStart = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 1));
      const agentCol = side.role === 'buy' ? deals.buyerAgentId : deals.sellerAgentId;
      const [row] = await db
        .select({ total: sql<string>`coalesce(sum(${deals.amount}), 0)` })
        .from(deals)
        .where(
          and(
            eq(agentCol, side.agentId),
            eq(deals.currency, deal.currency),
            ne(deals.id, deal.id),
            gte(deals.createdAt, monthStart),
            isNotNull(deals.authorityPassedAt),
            notInArray(deals.status, ['rejected', 'cancelled', 'refunded']),
          ),
        );
      const spent = BigInt(row?.total ?? 0);
      if (spent + exposure > m.monthlyLimit) {
        failures.push(
          `${label} monthly limit ${m.monthlyLimit} exceeded (${spent} already committed)`,
        );
      }
    }
  }
  if (!failures.length) {
    await db.update(deals).set({ authorityPassedAt: now }).where(eq(deals.id, deal.id));
  }
  return failures;
}
