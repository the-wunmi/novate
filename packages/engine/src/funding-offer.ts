import { DomainError, mulDivUp, type Principal, sideOf } from '@novate/core';
import { type Tx, x402Payments } from '@novate/db';
import { Accounts } from '@novate/ledger';
import { and, eq, isNull, ne, or, sql } from 'drizzle-orm';
import { deps, tx } from './deps.ts';
import { type DealRow, escrowCurrency, getDeal, snapshotOf } from './repo.ts';

export interface FundingOffer {
  dealId: string;
  tenantId: string;
  memberId: string;
  currency: string;
  rail: string;
  /** Minor units still needed to fund the deal, after what the buyer's wallet already holds. */
  amount: bigint;
}

export const mayPayFor = (p: Principal, d: DealRow) =>
  p.tenantId === d.tenantId &&
  (p.kind === 'platform' ||
    p.kind === 'house' ||
    sideOf(p, d) === 'buyer' ||
    (p.kind === 'agent' && p.agentId === d.buyerAgentId));

/** A settle that never answered may still land for this long. After it, the payment is dead. */
export const recentlyOpened = sql`${x402Payments.createdAt} > now() - interval '1 hour'`;

/** An x402 payment that can still bring money in for this deal, so a second must not be offered. */
export async function openX402(db: Tx, dealId: string) {
  const [row] = await db
    .select()
    .from(x402Payments)
    .where(
      and(
        eq(x402Payments.dealId, dealId),
        ne(x402Payments.status, 'refused'),
        isNull(x402Payments.claimedRef),
        or(ne(x402Payments.status, 'pending'), recentlyOpened),
      ),
    )
    .limit(1);
  return row;
}

async function owed(db: Tx, dealId: string, principal: Principal): Promise<FundingOffer> {
  const deal = await getDeal(db, dealId);
  if (!mayPayFor(principal, deal)) throw new DomainError('not_found', 'Deal not found');
  const { resolved } = snapshotOf(deal);
  if (deal.status !== 'awaiting_funding') {
    throw new DomainError('conflict', `Deal is ${deal.status}, not waiting for funds`);
  }
  if (escrowCurrency(deal) !== deal.currency) {
    throw new DomainError('invalid', 'This deal is funded in another currency');
  }
  const needed = mulDivUp(deal.amount, BigInt(resolved.fundingBps), 10_000n);
  const wallet = Accounts.memberAvailable(deal.buyerMemberId, deal.currency);
  const held = await deps().ledger.balance(db, deal.tenantId, wallet);
  if (held >= needed) throw new DomainError('conflict', 'The buyer already has enough funds');
  return {
    dealId,
    tenantId: deal.tenantId,
    memberId: deal.buyerMemberId,
    currency: deal.currency,
    rail: resolved.policy.settlement.rail,
    amount: needed - held,
  };
}

/** What the buyer still has to pay in to fund this deal, or why it cannot be paid now. */
export function fundingOffer(dealId: string, principal: Principal): Promise<FundingOffer> {
  return tx('funding_offer', async (db) => {
    const offer = await owed(db, dealId, principal);
    if (await openX402(db, dealId)) {
      throw new DomainError('conflict', 'An x402 payment for this deal is still in progress');
    }
    return offer;
  });
}

/** The same, for the x402 route, which has to see an open payment to answer a retry of it. */
export function x402FundingOffer(dealId: string, principal: Principal) {
  return tx('funding_offer', async (db) => ({
    ...(await owed(db, dealId, principal)),
    open: await openX402(db, dealId),
  }));
}
