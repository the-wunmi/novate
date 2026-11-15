import { DBOS } from '@dbos-inc/dbos-sdk';
import { DomainError, minBig } from '@novate/core';
import {
  members,
  railCursors,
  railEvents,
  settlementInstructions,
  type Tx,
  unattributedDeposits,
} from '@novate/db';
import { Accounts } from '@novate/ledger';
import type { RailEvent, SettlementRail } from '@novate/rails';
import { and, eq, sql } from 'drizzle-orm';
import { cardPaymentEvent } from './card-funding.ts';
import { deps, isWorkflowControl, networkStep, tx } from './deps.ts';
import { deposit, depositTransfer, holdUnmatchedDeposit } from './funds.ts';
import { notify } from './notifications.ts';
import { getMember } from './repo.ts';
import { stableUuid } from './settlement-group.ts';
import { Topics } from './topics.ts';
import { claimX402Payment } from './x402.ts';

/**
 * Take a webhook in. Verifies it, stores it once, and hands it to a durable workflow, so the
 * endpoint can answer straight away and repeated deliveries do nothing.
 */
export async function ingestRailEvent(
  railName: string,
  rawBody: string,
  headers: Record<string, string>,
): Promise<{ duplicate: boolean }> {
  const rail = deps().rails.get(railName);
  let event: RailEvent;
  try {
    event = rail.parseEvent(rawBody, headers);
  } catch (err) {
    throw new DomainError('invalid', `Rejected webhook: ${(err as Error).message}`);
  }
  // A card event only says to go and look, and its body could carry card details.
  const payload =
    event.type === 'card.updated'
      ? { id: event.id, type: event.type }
      : (JSON.parse(rawBody) as Record<string, unknown>);
  return recordRailEvent(railName, event, payload);
}

/** Store an event once and start its workflow. The same path for webhooks and polled rails. */
async function recordRailEvent(
  railName: string,
  event: RailEvent,
  payload: Record<string, unknown>,
): Promise<{ duplicate: boolean }> {
  const { created, rowId } = await tx('record_event', async (db) => {
    const [inserted] = await db
      .insert(railEvents)
      .values({
        rail: railName,
        externalId: event.id,
        type: event.type,
        payload,
        occurredAt: new Date(event.occurredAt),
      })
      .onConflictDoNothing()
      .returning({ id: railEvents.id });
    if (inserted) return { created: true, rowId: inserted.id };
    const [existing] = await db
      .select({ id: railEvents.id })
      .from(railEvents)
      .where(and(eq(railEvents.rail, railName), eq(railEvents.externalId, event.id)));
    return { created: false, rowId: existing?.id as string };
  });
  // Started on every delivery, and safe to: the id is stable. A crash before this line is retried.
  await DBOS.startWorkflow(railEventWorkflow, {
    workflowID: stableUuid(`${railName}:${event.id}`),
  })(railName, rowId, event);
  return { duplicate: !created };
}

const EVENT_ATTEMPTS = 12;
const EVENT_RETRY_MS = 5_000;
const MAX_EVENT_RETRY_MS = 3_600_000;

/** Enough to clear a long outage over a few ticks without one tick running forever. */
const MAX_POLL_PAGES = 100;

/** Bring in what rails with no webhooks have seen. The cursor moves only after events are stored. */
export async function pollRailEvents(rail: SettlementRail): Promise<void> {
  if (!rail.pollEvents) return;
  const poll = rail.pollEvents.bind(rail);
  let cursor = await tx('poll_cursor', async (db) => {
    const [row] = await db.select().from(railCursors).where(eq(railCursors.rail, rail.name));
    return row?.position ?? null;
  });
  for (let page = 0; page < MAX_POLL_PAGES; page++) {
    const from = cursor;
    const { events, cursor: next, caughtUp } = await networkStep('rail_poll', () => poll(from));
    for (const event of events) await recordRailEvent(rail.name, event, { ...event });
    await tx('poll_cursor_save', (db) =>
      db
        .insert(railCursors)
        .values({ rail: rail.name, position: next })
        .onConflictDoUpdate({ target: railCursors.rail, set: { position: next } }),
    );
    cursor = next;
    if (caughtUp) return;
  }
}

/** Public webhook endpoints exist only for rails whose events are signed. */
export function railAcceptsWebhooks(name: string): boolean {
  const { rails } = deps();
  return rails.has(name) && rails.get(name).capabilities.signedEvents;
}

async function processRailEvent(
  railName: string,
  rowId: string,
  event: RailEvent,
): Promise<string> {
  const outcome = await routeWithRetries(railName, event);
  await tx('event_done', (db) =>
    db.update(railEvents).set({ processedAt: new Date(), outcome }).where(eq(railEvents.id, rowId)),
  );
  return outcome;
}

export const railEventWorkflow = DBOS.registerWorkflow(processRailEvent, {
  name: 'processRailEvent',
});

/** Handling is idempotent, so trying again is always safe. An event may be someone's money. */
async function routeWithRetries(railName: string, event: RailEvent): Promise<string> {
  for (let attempt = 0; ; attempt++) {
    try {
      return await route(railName, event);
    } catch (err) {
      if (isWorkflowControl(err)) throw err;
      console.error(`Rail event ${event.id} failed, attempt ${attempt + 1}:`, err);
      if (attempt + 1 >= EVENT_ATTEMPTS) {
        await notify({
          type: 'rail_event_failed',
          rail: railName,
          eventId: event.id,
          reason: (err as Error).message.slice(0, 500),
        });
        return 'failed';
      }
      await DBOS.sleep(Math.min(MAX_EVENT_RETRY_MS, EVENT_RETRY_MS * 2 ** attempt));
    }
  }
}

async function route(railName: string, event: RailEvent): Promise<string> {
  switch (event.type) {
    case 'deposit.settled':
      return depositSettled(railName, event);
    case 'deposit.reversed':
      return tx('deposit_reversed', (db) => depositReversed(db, railName, event));
    case 'card.updated':
      return cardPaymentEvent(railName, event);
    case 'payment.confirmed':
    case 'payment.failed':
    case 'payment.returned':
      return paymentEvent(railName, event);
    default:
      return 'ignored';
  }
}

async function paymentEvent(railName: string, event: RailEvent): Promise<string> {
  const ref = event.externalRef;
  if (!ref) return 'malformed';
  const ins = await tx('event_instruction', (db) => instructionByRef(db, ref));
  if (!ins) return 'unknown_instruction';
  // Airwallex can fail a payment it already reported as paid. That is a return, not a wake-up.
  if (
    event.type === 'payment.returned' ||
    (event.type === 'payment.failed' && ins.status === 'confirmed')
  ) {
    return tx('payment_returned', (db) => paymentReturned(db, railName, ins, ref, event));
  }
  await DBOS.send(ins.cycleId, { externalRef: ref }, Topics.rail, `rail:${event.id}`);
  return 'cycle_woken';
}

/** Money goes to a member only if exactly one, in the tenant owning this rail, holds that account. */
async function memberForDeposit(db: Tx, railName: string, ref: string) {
  const owner = deps().railOwners[railName];
  const matches = await db
    .select()
    .from(members)
    .where(
      and(
        sql`lower(${members.railRefs}->>${`${railName}_deposit_account`}) = ${ref.toLowerCase()}`,
        owner ? eq(members.tenantId, owner) : undefined,
      ),
    );
  return matches.length === 1 ? matches[0] : undefined;
}

async function depositSettled(railName: string, event: RailEvent): Promise<string> {
  const ref = event.depositAccountRef;
  if (!ref || !event.externalRef || event.amount === undefined || !event.currency)
    return 'malformed';
  const { externalRef, amount } = event;
  const paid = await tx('x402_claim', (db) =>
    claimX402Payment(db, railName, ref, amount, externalRef),
  );
  if (paid) {
    await deposit(paid.tenantId, {
      memberId: paid.memberId,
      currency: event.currency,
      amount,
      rail: railName,
      externalRef,
    });
    return 'credited';
  }
  const member = await tx('deposit_member', (db) => memberForDeposit(db, railName, ref));
  if (!member) {
    const tenantId = deps().railOwners[railName];
    if (!tenantId) return 'unattributed';
    const unmatched = {
      rail: railName,
      externalRef: event.externalRef,
      depositAccountRef: ref,
      currency: event.currency,
      amount: event.amount,
    };
    await tx('deposit_suspense', (db) => holdUnmatchedDeposit(db, tenantId, unmatched));
    return 'suspense';
  }
  await deposit(member.tenantId, {
    memberId: member.id,
    currency: event.currency,
    amount: event.amount,
    rail: railName,
    externalRef: event.externalRef,
  });
  return 'credited';
}

/** The bank recalled money already credited. Take it back, and let the member go negative if spent. */
async function depositReversed(db: Tx, railName: string, event: RailEvent): Promise<string> {
  const ref = event.depositAccountRef;
  if (!ref || !event.externalRef || event.amount === undefined || !event.currency)
    return 'malformed';
  const { ledger } = deps();
  const recalled = {
    rail: railName,
    externalRef: event.externalRef,
    depositAccountRef: ref,
    currency: event.currency,
    amount: event.amount,
  };
  const owner = deps().railOwners[railName];
  const matched = await memberForDeposit(db, railName, ref);
  // Events arrive in any order. Booking the deposit first means a recall that overtook it nets to
  // nothing, and the settled event, when it comes, finds its ledger entry already there.
  if (!matched && owner) await holdUnmatchedDeposit(db, owner, recalled);
  const [held] = await db
    .select()
    .from(unattributedDeposits)
    .where(
      and(
        eq(unattributedDeposits.rail, railName),
        eq(unattributedDeposits.externalRef, event.externalRef),
      ),
    )
    .for('update');
  if (held?.status === 'open') {
    await ledger.post(db, held.tenantId, [
      {
        key: `deposit:${railName}:${event.externalRef}:reversed:suspense`,
        debit: Accounts.houseSuspense(event.currency),
        credit: Accounts.houseCash(railName, event.currency),
        amount: held.amount,
        kind: 'deposit_reversal',
        ref: event.externalRef,
      },
    ]);
    await db
      .update(unattributedDeposits)
      .set({ status: 'reversed' })
      .where(eq(unattributedDeposits.id, held.id));
    return 'reversed_from_suspense';
  }
  // Already assigned to someone: from here it is that member's deposit like any other.
  const member = held?.memberId ? await getMember(db, held.memberId) : matched;
  if (!member) return 'unattributed';
  if (matched) {
    await ledger.post(db, member.tenantId, [
      depositTransfer(recalled, Accounts.memberAvailable(member.id, event.currency)),
    ]);
  }
  const available = Accounts.memberAvailable(member.id, event.currency);
  const take = minBig(await ledger.balance(db, member.tenantId, available), event.amount);
  const short = event.amount - take;
  const cash = Accounts.houseCash(railName, event.currency);
  const key = `deposit:${railName}:${event.externalRef}:reversed`;
  const transfers = [];
  if (take > 0n) {
    transfers.push({
      key: `${key}:wallet`,
      debit: available,
      credit: cash,
      amount: take,
      kind: 'deposit_reversal',
      ref: event.externalRef,
    });
  }
  if (short > 0n) {
    transfers.push({
      key: `${key}:shortfall`,
      debit: Accounts.memberDebt(member.id, event.currency),
      credit: cash,
      amount: short,
      kind: 'deposit_reversal_shortfall',
      ref: event.externalRef,
    });
  }
  await ledger.post(db, member.tenantId, transfers);
  if (short > 0n) {
    await db.update(members).set({ status: 'suspended' }).where(eq(members.id, member.id));
    return 'reversed_member_suspended';
  }
  return 'reversed';
}

type Instruction = typeof settlementInstructions.$inferSelect;

const instructionByRef = async (db: Tx, ref: string) => {
  const [ins] = await db
    .select()
    .from(settlementInstructions)
    .where(eq(settlementInstructions.externalRef, ref));
  return ins;
};

/** A payment reported as paid has come back. The money returns to the member as a balance. */
async function paymentReturned(
  db: Tx,
  railName: string,
  ins: Instruction,
  ref: string,
  event: RailEvent,
): Promise<string> {
  if (ins.direction !== 'payout') return 'unknown_instruction';
  if (ins.status !== 'confirmed') return `ignored_${ins.status}`;
  // The rail keeps its fee from what it hands back, so only the rest can be credited.
  const kept = event.fee?.currency === ins.currency ? event.fee.amount : 0n;
  await deps().ledger.post(db, ins.tenantId, [
    {
      key: `instruction:${ins.id}:returned`,
      debit: Accounts.houseCash(railName, ins.currency),
      credit: Accounts.memberAvailable(ins.memberId, ins.currency),
      amount: ins.amount - kept,
      kind: 'payout_returned',
      ref,
    },
  ]);
  await db
    .update(settlementInstructions)
    .set({ status: 'reversed', failureReason: 'returned after confirmation' })
    .where(
      and(eq(settlementInstructions.id, ins.id), eq(settlementInstructions.status, 'confirmed')),
    );
  return 'returned_to_wallet';
}
