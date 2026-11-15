import { DBOS } from '@dbos-inc/dbos-sdk';
import { DomainError, minBig } from '@novate/core';
import { dealEvents, deals, decisionCases, type Tx } from '@novate/db';
import { Accounts } from '@novate/ledger';
import { type Claimant, durationMs } from '@novate/policy';
import { and, desc, eq, sql } from 'drizzle-orm';
import { dealCase, resolveCase } from './decisions.ts';
import { deps, tx } from './deps.ts';
import { type DealRow, getDeal, record, setStatus, snapshotOf } from './repo.ts';

/** When a settled deal stops taking claims, or null if it has not settled. */
export function claimDeadline(deal: DealRow, settledAt: Date | null): Date | null {
  if (!settledAt) return null;
  const window = snapshotOf(deal).resolved.policy.release.claimWindow;
  return new Date(settledAt.getTime() + durationMs(window));
}

/** What the seller was paid for a settled deal, in the deal's currency. */
export const paidOn = (deal: DealRow) => deal.releaseAmount ?? deal.amount;

/** What a partial release held back from the seller: what a seller's claim can ask for. */
export const heldBack = (deal: DealRow) => deal.amount - paidOn(deal);

/**
 * Whether a party may still file a claim against a settled deal, and whether its own is already
 * open. While the other side's claim is open it is refused, so neither claim is lost as evidence in
 * the other's case. A seller may claim only what a partial release held back. Called with the deal
 * row locked, so two claims filed at once cannot both open a case.
 */
export async function claimStanding(
  db: Tx,
  deal: DealRow,
  claimant: Claimant,
  now: Date,
): Promise<{ alreadyOpen: boolean }> {
  if (deal.status !== 'settled' || deal.releaseAmount === null) {
    throw new DomainError('conflict', `Deal is ${deal.status}`);
  }
  if (claimant === 'seller' && heldBack(deal) <= 0n) {
    throw new DomainError('conflict', 'The seller was paid in full');
  }
  const [settled] = await db
    .select({ at: dealEvents.createdAt })
    .from(dealEvents)
    .where(and(eq(dealEvents.dealId, deal.id), eq(dealEvents.type, 'settled')))
    .orderBy(desc(dealEvents.createdAt))
    .limit(1);
  const deadline = claimDeadline(deal, settled?.at ?? null);
  if (!deadline || now > deadline) {
    const window = snapshotOf(deal).resolved.policy.release.claimWindow;
    throw new DomainError('conflict', `The ${window} claim window after settlement has passed`);
  }
  const [open] = await db
    .select({ context: decisionCases.context })
    .from(decisionCases)
    .where(
      and(
        eq(decisionCases.dealId, deal.id),
        eq(decisionCases.kind, 'exception'),
        eq(decisionCases.status, 'open'),
      ),
    );
  const openBy = (open?.context as { claimant?: Claimant } | undefined)?.claimant;
  if (openBy && openBy !== claimant) {
    throw new DomainError('conflict', `A claim by the ${openBy} is open: add evidence to it`);
  }
  return { alreadyOpen: Boolean(open) };
}

/**
 * A claim against a settled deal goes to the deal's deciders as an `exception` case. A buyer's is
 * granted with a refund: what it asked for, or else what the seller was paid, back to the buyer, from
 * the seller's wallet first, and what the wallet cannot cover becomes the seller's debt to the house.
 * A seller's, that it was paid short, is granted with `release_full`: what it asked for, or else all
 * the partial release held back, paid from the buyer's wallet the same way.
 */
async function runClaim(
  dealId: string,
  factId: string,
  reason: string,
  requested: string | undefined,
  claimant: Claimant,
): Promise<string> {
  const deal = await tx('claim_load', (db) => getDeal(db, dealId));
  const { decisions } = snapshotOf(deal).resolved.policy;
  const most = claimant === 'seller' ? heldBack(deal) : paidOn(deal);
  const amount = requested === undefined ? most : minBig(BigInt(requested), most);
  while (true) {
    const res = await resolveCase(
      dealCase(
        deal,
        decisions,
        'exception',
        `${claimant === 'seller' ? "Seller's" : "Buyer's"} claim after settlement: ${reason}`,
        {
          claim: {
            factId,
            reason,
            by: claimant,
            ...(requested === undefined ? {} : { requested: amount }),
          },
          paid: paidOn(deal),
          ...(claimant === 'seller' ? { heldBack: heldBack(deal) } : {}),
          currency: deal.currency,
        },
        { amount, workflowId: DBOS.workflowID, claimant },
      ),
    );
    if (res.outcome === 'stale') continue;
    if (res.outcome === 'decided' && claimant === 'buyer' && res.action.type === 'refund') {
      const why = `claim refunded by ${res.decider.type}`;
      await tx('claim_refund', (db) => refundClaim(db, deal, res.caseId, why, amount, factId));
      return 'refunded';
    }
    if (res.outcome === 'decided' && claimant === 'seller' && res.action.type === 'release_full') {
      await tx('claim_pay', (db) => payClaim(db, deal, res.caseId, amount, factId));
      return 'paid';
    }
    const outcome = res.outcome === 'decided' ? res.action.type : res.outcome;
    await tx('claim_closed', (db) =>
      record(db, deal.id, 'claim_closed', { factId, caseId: res.caseId, outcome }),
    );
    return outcome;
  }
}

export const claimWorkflow = DBOS.registerWorkflow(runClaim, { name: 'settledDealClaim' });

/** Keys are per case, so a replay moves nothing twice. */
export async function refundClaim(
  db: Tx,
  deal: DealRow,
  caseId: string,
  reason: string,
  amount = paidOn(deal),
  factId?: string,
) {
  const { ledger } = deps();
  const currency = deal.currency;
  const wallet = Accounts.memberAvailable(deal.sellerMemberId, currency);
  const fromWallet = minBig(await ledger.balance(db, deal.tenantId, wallet), amount);
  const owed = amount - fromWallet;
  const buyer = Accounts.memberAvailable(deal.buyerMemberId, currency);
  const key = `deal:${deal.id}:claim:${caseId}`;
  await ledger.post(db, deal.tenantId, [
    ...(fromWallet > 0n
      ? [
          {
            key: `${key}:wallet`,
            debit: wallet,
            credit: buyer,
            amount: fromWallet,
            kind: 'claim_refund',
            ref: deal.id,
          },
        ]
      : []),
    ...(owed > 0n
      ? [
          {
            key: `${key}:debt`,
            debit: Accounts.memberDebt(deal.sellerMemberId, currency),
            credit: buyer,
            amount: owed,
            kind: 'claim_refund_shortfall',
            ref: deal.id,
          },
        ]
      : []),
  ]);
  await setStatus(
    db,
    deal.id,
    'refunded',
    {
      type: 'claim_refunded',
      payload: {
        caseId,
        ...(factId ? { factId } : {}),
        amount,
        currency,
        fromSellerWallet: fromWallet,
        sellerOwes: owed,
      },
    },
    reason,
  );
}

/**
 * Pay a seller what a partial release held back, as a granted claim: from the buyer's wallet first,
 * and what that cannot cover becomes the buyer's debt to the house. Keys are per case.
 */
export async function payClaim(
  db: Tx,
  deal: DealRow,
  caseId: string,
  amount: bigint,
  factId: string,
) {
  const { ledger } = deps();
  const currency = deal.currency;
  const wallet = Accounts.memberAvailable(deal.buyerMemberId, currency);
  const fromWallet = minBig(await ledger.balance(db, deal.tenantId, wallet), amount);
  const owed = amount - fromWallet;
  const seller = Accounts.memberAvailable(deal.sellerMemberId, currency);
  const key = `deal:${deal.id}:claim:${caseId}`;
  await ledger.post(db, deal.tenantId, [
    ...(fromWallet > 0n
      ? [
          {
            key: `${key}:wallet`,
            debit: wallet,
            credit: seller,
            amount: fromWallet,
            kind: 'claim_payment',
            ref: deal.id,
          },
        ]
      : []),
    ...(owed > 0n
      ? [
          {
            key: `${key}:debt`,
            debit: Accounts.memberDebt(deal.buyerMemberId, currency),
            credit: seller,
            amount: owed,
            kind: 'claim_payment_shortfall',
            ref: deal.id,
          },
        ]
      : []),
  ]);
  await db
    .update(deals)
    .set({ releaseAmount: sql`${deals.releaseAmount} + ${amount}` })
    .where(eq(deals.id, deal.id));
  await record(db, deal.id, 'claim_paid', {
    caseId,
    factId,
    amount,
    currency,
    fromBuyerWallet: fromWallet,
    buyerOwes: owed,
  });
}
