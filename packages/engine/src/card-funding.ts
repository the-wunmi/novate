import {
  absBig,
  DomainError,
  MinorAmount,
  minBig,
  mulDivUp,
  type Principal,
  parseInput,
} from '@novate/core';
import { cardPayments, type Tx } from '@novate/db';
import { Accounts } from '@novate/ledger';
import {
  type CardAcceptance,
  type CardResult,
  isRailFee,
  type RailEvent,
  type RailTransaction,
} from '@novate/rails';
import { and, eq, isNull, lt } from 'drizzle-orm';
import { z } from 'zod';
import { railRefusal } from './deal-policy.ts';
import { deps, isWorkflowControl, networkStep, tx } from './deps.ts';
import { type FundingOffer, fundingOffer, mayPayFor } from './funding-offer.ts';
import { postDeposit, wakeFundsWaiters } from './funds.ts';
import { getDeal, record } from './repo.ts';
import { stableUuid } from './settlement-group.ts';

/** A payment still open after this long lost its answer, and is settled by asking the rail. */
const STUCK_AFTER_MS = 2 * 60_000;

/** A retry this late could race the monitor closing the payment, so it only asks for the answer. */
const NO_RETRY_AFTER_MS = 60_000;

/**
 * Added to what a card payment asks for, since the rail's fee is only known once it pays over.
 * It stays in the buyer's wallet, and the real fee comes out of it, so members' claims on the
 * house never exceed the cash that actually arrives. What is left over remains the buyer's.
 */
const CARD_FEE_BUFFER_BPS = 400n;

export const PayDealByCard = z.object({
  /** The Airi mandate the card credential was issued under. One mandate pays once. */
  mandateId: z.string().min(1).max(128),
  /** What the mandate authorised. A deal that now needs a different amount needs a new mandate. */
  amount: MinorAmount,
  card: z.object({
    number: z.string().regex(/^\d{12,19}$/),
    expiryMonth: z.string().regex(/^\d{2}$/),
    expiryYear: z.string().regex(/^\d{4}$/),
    cvc: z.string().regex(/^\d{3,4}$/),
    name: z.string().min(1).max(128),
  }),
});

type CardPayment = typeof cardPayments.$inferSelect;

export interface CardOutcome {
  paymentId: string;
  status: 'succeeded' | 'pending' | 'failed';
  reason?: string;
}

const outcome = (row: CardPayment): CardOutcome => ({
  paymentId: row.id,
  status: row.status === 'open' ? 'pending' : row.status,
  ...(row.reason ? { reason: row.reason } : {}),
});

function cardsOn(railName: string): CardAcceptance {
  const cards = deps().rails.get(railName).cards;
  if (!cards) throw new DomainError('invalid', `Rail ${railName} does not take card payments`);
  return cards;
}

/** What a buyer's agent needs in order to ask Airi for a mandate of exactly this amount. */
export async function cardOffer(dealId: string, principal: Principal): Promise<FundingOffer> {
  const offer = await fundingOffer(dealId, principal);
  const refusal = railRefusal(offer.tenantId, offer.rail);
  if (refusal) throw new DomainError('invalid', refusal);
  cardsOn(offer.rail);
  return { ...offer, amount: mulDivUp(offer.amount, 10_000n + CARD_FEE_BUFFER_BPS, 10_000n) };
}

const paymentByMandate = (db: Tx, mandateId: string) =>
  db.select().from(cardPayments).where(eq(cardPayments.mandateId, mandateId));

async function openCardPayment(offer: FundingOffer, mandateId: string): Promise<CardPayment> {
  return tx('card_open', async (db) => {
    await db
      .insert(cardPayments)
      .values({
        tenantId: offer.tenantId,
        dealId: offer.dealId,
        memberId: offer.memberId,
        rail: offer.rail,
        mandateId,
        amount: offer.amount,
        currency: offer.currency,
      })
      .onConflictDoNothing();
    const [row] = await paymentByMandate(db, mandateId);
    // No row means the insert lost to the one open payment this deal is allowed.
    if (row?.dealId !== offer.dealId) {
      throw new DomainError('conflict', 'Another card payment for this deal is in progress');
    }
    return row;
  });
}

async function createIntent(row: CardPayment, cards: CardAcceptance): Promise<string> {
  const { intentId } = await cards.create({
    requestId: stableUuid(`card-intent:${row.id}`),
    orderId: row.id,
    amount: row.amount,
    currency: row.currency,
    descriptor: 'novate deal funding',
  });
  await tx('card_intent', (db) =>
    db.update(cardPayments).set({ intentId }).where(eq(cardPayments.id, row.id)),
  );
  return intentId;
}

/**
 * Charge a card credential to fund a deal. Runs in the request, never in a workflow, because DBOS
 * saves workflow inputs and a card number must not reach the database. If the answer is lost the
 * payment stays open, and the rail's webhook or the monitor settles it from the rail's own record.
 */
export async function payDealByCard(
  dealId: string,
  principal: Principal,
  input: z.input<typeof PayDealByCard>,
): Promise<CardOutcome> {
  const { mandateId, amount, card } = parseInput(PayDealByCard, input);
  const [prior] = await tx('card_prior', (db) => paymentByMandate(db, mandateId));
  // Already answered, so a retry after a lost response learns what happened.
  if (prior && prior.status !== 'open') {
    const deal = await tx('card_prior_deal', (db) => getDeal(db, prior.dealId));
    if (deal.id !== dealId || !mayPayFor(principal, deal)) {
      throw new DomainError('conflict', 'This mandate has already been used');
    }
    return outcome(prior);
  }
  const offer = await cardOffer(dealId, principal);
  if (amount !== offer.amount) {
    throw new DomainError('conflict', 'The amount owed has changed, so this needs a new mandate', {
      owed: offer.amount.toString(),
    });
  }
  const row = await openCardPayment(offer, mandateId);
  if (Date.now() - row.createdAt.getTime() > NO_RETRY_AFTER_MS) return outcome(row);
  const cards = cardsOn(offer.rail);
  try {
    const intentId = row.intentId ?? (await createIntent(row, cards));
    const requestId = stableUuid(`card-confirm:${row.id}`);
    return await finishCardPayment(row.id, await cards.confirm(intentId, requestId, card));
  } catch (err) {
    if (isWorkflowControl(err)) throw err;
    if (err instanceof DomainError) throw err;
    console.error(`Card payment ${row.id} has no answer yet:`, (err as Error).message);
    return { paymentId: row.id, status: 'pending' };
  }
}

/**
 * Record the rail's answer, in one transaction with the credit so the two cannot disagree. Keyed to
 * the payment, so it is safe to repeat and to race. Proof of capture beats an earlier failure,
 * because the money was taken. A failure never undoes a success.
 */
async function finishCardPayment(id: string, result: CardResult): Promise<CardOutcome> {
  const { row, waiting } = await tx('card_finish', async (db) => {
    const [current] = await db
      .select()
      .from(cardPayments)
      .where(eq(cardPayments.id, id))
      .for('update');
    if (!current) throw new DomainError('not_found', 'Card payment not found');
    const captured = result.status === 'succeeded';
    // Repeated on every report of capture: the ledger ignores it, and the wake-up may have been lost.
    const waiting = captured
      ? await postDeposit(db, current.tenantId, {
          memberId: current.memberId,
          currency: current.currency,
          amount: current.amount,
          rail: current.rail,
          externalRef: current.id,
        })
      : [];
    const changes =
      (captured && current.status !== 'succeeded') ||
      (result.status === 'failed' && current.status === 'open');
    if (!changes) {
      if (!result.attemptRef || current.attemptRef) return { row: current, waiting };
      const [named] = await db
        .update(cardPayments)
        .set({ attemptRef: result.attemptRef })
        .where(eq(cardPayments.id, id))
        .returning();
      return { row: named as CardPayment, waiting };
    }
    const [updated] = await db
      .update(cardPayments)
      .set({
        status: captured ? 'succeeded' : 'failed',
        intentId: result.intentId || current.intentId,
        attemptRef: result.attemptRef,
        reason: result.reason ?? null,
      })
      .where(eq(cardPayments.id, id))
      .returning();
    await record(db, current.dealId, captured ? 'card_funded' : 'card_refused', {
      mandateId: current.mandateId,
      paymentId: current.id,
      amount: current.amount,
      currency: current.currency,
      ...(result.reason ? { reason: result.reason } : {}),
    });
    return { row: updated as CardPayment, waiting };
  });
  await wakeFundsWaiters(waiting, row.id);
  return outcome(row);
}

/** The rail says a card payment changed. Ask it for the current state rather than trust order. */
export async function cardPaymentEvent(railName: string, event: RailEvent): Promise<string> {
  const intentId = event.externalRef;
  if (!intentId) return 'malformed';
  const [row] = await tx('card_by_intent', (db) =>
    db
      .select()
      .from(cardPayments)
      .where(and(eq(cardPayments.rail, railName), eq(cardPayments.intentId, intentId))),
  );
  if (!row) return 'unknown_card_payment';
  const cards = cardsOn(railName);
  const result = await networkStep('card_status', () => cards.status(intentId));
  return (await finishCardPayment(row.id, result)).status;
}

/** Finish payments whose answer was lost. Without an intent, nothing was ever charged. */
export async function resolveStuckCardPayments(tenantId: string, now: Date): Promise<void> {
  const stuck = await tx('card_stuck', (db) =>
    db
      .select()
      .from(cardPayments)
      .where(
        and(
          eq(cardPayments.tenantId, tenantId),
          eq(cardPayments.status, 'open'),
          lt(cardPayments.createdAt, new Date(now.getTime() - STUCK_AFTER_MS)),
        ),
      ),
  );
  for (const row of stuck) {
    const { intentId } = row;
    try {
      const result: CardResult = intentId
        ? await networkStep('card_status', () => cardsOn(row.rail).status(intentId))
        : { status: 'failed', intentId: '', reason: 'The payment never reached the card network' };
      await finishCardPayment(row.id, result);
    } catch (err) {
      // A rail outage must not stop the rest of the monitor. The next tick tries again.
      if (isWorkflowControl(err)) throw err;
      console.error(`Card payment ${row.id} is still unresolved:`, (err as Error).message);
    }
  }
}

/**
 * Card money reaches the rail balance after capture, net of fees. Reconciliation calls this first,
 * so a payment that has landed stops being expected, and its fee becomes a cost in the ledger.
 */
export async function settleCardPayments(
  db: Tx,
  tenantId: string,
  railName: string,
  transactions: RailTransaction[],
): Promise<void> {
  const waiting = await awaitingSettlement(db, tenantId, railName);
  const landed = new Map(
    transactions
      .filter((t) => t.status === 'settled' && !isRailFee(t))
      .map((t) => [t.externalRef, t]),
  );
  for (const row of waiting) {
    const found = row.attemptRef ? landed.get(row.attemptRef) : undefined;
    if (!found) continue;
    const fee = absBig(found.fee ?? 0n);
    if (fee > 0n) await chargeCardFee(db, row, found.externalRef, fee);
    await db
      .update(cardPayments)
      .set({ settledAt: new Date(found.occurredAt) })
      .where(eq(cardPayments.id, row.id));
  }
}

/** The buyer's card, so the buyer's cost. The buffer in the offer is there to cover it. */
async function chargeCardFee(db: Tx, row: CardPayment, ref: string, fee: bigint) {
  const { ledger } = deps();
  const wallet = Accounts.memberAvailable(row.memberId, row.currency);
  const take = minBig(await ledger.balance(db, row.tenantId, wallet), fee);
  const cash = Accounts.houseCash(row.rail, row.currency);
  const key = `card_fee:${row.rail}:${ref}`;
  const base = { credit: cash, ref };
  await ledger.post(db, row.tenantId, [
    ...(take > 0n ? [{ ...base, key, debit: wallet, amount: take, kind: 'card_fee' }] : []),
    ...(fee > take
      ? [
          {
            ...base,
            key: `${key}:shortfall`,
            debit: Accounts.memberDebt(row.memberId, row.currency),
            amount: fee - take,
            kind: 'card_fee_shortfall',
          },
        ]
      : []),
  ]);
}

const awaitingSettlement = (db: Tx, tenantId: string, railName: string) =>
  db
    .select()
    .from(cardPayments)
    .where(
      and(
        eq(cardPayments.tenantId, tenantId),
        eq(cardPayments.rail, railName),
        eq(cardPayments.status, 'succeeded'),
        isNull(cardPayments.settledAt),
      ),
    );

/** By currency: card money credited to members that the rail has not yet paid over. */
export async function cardsAwaitingSettlement(
  db: Tx,
  tenantId: string,
  railName: string,
): Promise<Map<string, bigint>> {
  const totals = new Map<string, bigint>();
  for (const row of await awaitingSettlement(db, tenantId, railName)) {
    totals.set(row.currency, (totals.get(row.currency) ?? 0n) + row.amount);
  }
  return totals;
}
