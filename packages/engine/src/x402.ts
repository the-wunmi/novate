import { DomainError, type Principal } from '@novate/core';
import { deals, type Tx, x402Payments } from '@novate/db';
import { and, asc, eq, isNull, ne, or, sql } from 'drizzle-orm';
import { tx } from './deps.ts';
import { type FundingOffer, openX402, recentlyOpened, x402FundingOffer } from './funding-offer.ts';
import { record } from './repo.ts';

/** `open` is a payment already under way for this deal: a retry of it, or a reason to refuse another. */
export type X402Offer = FundingOffer & { open?: typeof x402Payments.$inferSelect };

const X402_RAIL = 'metal';

/** What a buyer has to pay to fund this deal, or why it cannot be funded this way. */
export async function x402Offer(dealId: string, principal: Principal): Promise<X402Offer> {
  const offer = await x402FundingOffer(dealId, principal);
  if (offer.currency !== 'USD' || offer.rail !== X402_RAIL) {
    throw new DomainError('invalid', 'This deal does not settle in USD on Metal');
  }
  return offer;
}

/**
 * Say who a payment is from before it is settled, because the chain only shows an address. Keyed
 * on the authorization, not the header's bytes, so a retry or a re-encoding is the same row. The
 * deal lock is what lets only one payment be open at a time.
 */
export async function openX402Payment(
  offer: X402Offer,
  payer: string,
  authorizationKey: string,
): Promise<string> {
  return tx('x402_open', async (db) => {
    await db.select({ id: deals.id }).from(deals).where(eq(deals.id, offer.dealId)).for('update');
    const [existing] = await db
      .select()
      .from(x402Payments)
      .where(eq(x402Payments.signatureHash, authorizationKey));
    if (existing && existing.dealId !== offer.dealId) {
      throw new DomainError('conflict', 'This payment was made for another deal');
    }
    const open = await openX402(db, offer.dealId);
    if (open && open.id !== existing?.id) {
      throw new DomainError('conflict', 'An x402 payment for this deal is still in progress');
    }
    if (existing) {
      // A refusal where nothing moved can be tried again with the same authorization.
      if (existing.status === 'refused') {
        await db
          .update(x402Payments)
          .set({ status: 'pending', reason: null, payer: payer.toLowerCase() })
          .where(eq(x402Payments.id, existing.id));
      }
      return existing.id;
    }
    const [row] = await db
      .insert(x402Payments)
      .values({
        tenantId: offer.tenantId,
        dealId: offer.dealId,
        memberId: offer.memberId,
        rail: X402_RAIL,
        payer: payer.toLowerCase(),
        amount: offer.amount,
        signatureHash: authorizationKey,
      })
      .returning({ id: x402Payments.id });
    return (row as { id: string }).id;
  });
}

/** Keep the transaction a payment became. `pending` leaves it open for finality or a retry. */
export const markX402Settled = (
  id: string,
  txHash: string,
  status: 'settled' | 'pending' = 'settled',
) =>
  tx('x402_settled', (db) =>
    db
      .update(x402Payments)
      .set({ status, txHash })
      .where(and(eq(x402Payments.id, id), ne(x402Payments.status, 'settled'))),
  );

/** A refusal is kept on the deal, including a spending mandate refused on-chain. */
export const recordX402Refusal = (
  offer: X402Offer,
  reason: string,
  paymentId?: string,
  transaction?: string,
) =>
  tx('x402_refused', async (db) => {
    await record(db, offer.dealId, 'x402_refused', { reason, transaction });
    if (paymentId) {
      await db
        .update(x402Payments)
        .set({ status: 'refused', reason })
        .where(and(eq(x402Payments.id, paymentId), ne(x402Payments.status, 'settled')));
    }
  });

/** What the chain proves about who authorised a payment, kept on the deal for any later dispute. */
export const recordMandateProof = (offer: X402Offer, proof: Record<string, unknown>) =>
  tx('x402_proof', (db) => record(db, offer.dealId, 'mandate_proof', proof));

/**
 * Match a finalized deposit to the x402 payment behind it. Money is only ever credited here, once
 * the chain has finalized it, so a settled payment cannot be counted early or counted twice.
 */
export async function claimX402Payment(
  db: Tx,
  rail: string,
  payer: string,
  amount: bigint,
  externalRef: string,
) {
  const [alreadyClaimed] = await db
    .select()
    .from(x402Payments)
    .where(eq(x402Payments.claimedRef, externalRef));
  if (alreadyClaimed) return alreadyClaimed;
  const [row] = await db
    .select()
    .from(x402Payments)
    .where(
      and(
        eq(x402Payments.rail, rail),
        eq(x402Payments.payer, payer.toLowerCase()),
        eq(x402Payments.amount, amount),
        isNull(x402Payments.claimedRef),
        ne(x402Payments.status, 'refused'),
        or(
          and(isNull(x402Payments.txHash), recentlyOpened),
          sql`${externalRef} like ${x402Payments.txHash} || ':%'`,
        ),
      ),
    )
    // The payment that names this transaction comes before one that has not said which it is.
    .orderBy(sql`${x402Payments.txHash} is null`, asc(x402Payments.createdAt))
    .limit(1)
    .for('update');
  if (!row) return undefined;
  await db.update(x402Payments).set({ claimedRef: externalRef }).where(eq(x402Payments.id, row.id));
  return row;
}
