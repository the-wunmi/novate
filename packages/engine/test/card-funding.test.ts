import { randomUUID } from 'node:crypto';
import { cardPayments, dealEvents, ledgerTransfers, railEvents } from '@novate/db';
import { presetInputs } from '@novate/policy';
import { MockRail } from '@novate/rails';
import { and, eq } from 'drizzle-orm';
import pg from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  type Engine,
  ingestRailEvent,
  listDeals,
  payDealByCard,
  resolveStuckCardPayments,
} from '../src/index.ts';
import { boot, makeWorld, reconcile, shutdown, type World, waitFor } from './harness.ts';

const rail = new MockRail();
let engine: Engine;

beforeAll(async () => {
  engine = await boot(rail);
}, 60_000);
afterAll(() => shutdown());

const CARD = '4111111111111111';
/** The EUR 50 owed, plus the buffer that covers the rail's fee. */
const AMOUNT = 5_200n;

const program = {
  ...presetInputs.realtimeAgentClearing,
  checks: [],
  authority: { enforceMandate: false },
  settlement: { rail: 'mock', netting: 'gross', timing: { mode: 'immediate' } },
} as never;

async function waitingDeal(): Promise<{ w: World; dealId: string }> {
  const w = await makeWorld(rail, { rt: program });
  const deal = await w.deal({
    program: 'rt',
    buyer: 'retailer',
    seller: 'supplier',
    quantity: 1,
    price: '50',
  });
  await waitFor(deal.id, ['awaiting_funding']);
  return { w, dealId: deal.id };
}

const pay = (w: World, dealId: string, mandateId: string, number = CARD, amount = AMOUNT) =>
  payDealByCard(dealId, w.platform, {
    mandateId,
    amount,
    card: { number, expiryMonth: '03', expiryYear: '2031', cvc: '737', name: 'A Buyer' },
  });

const mandate = () => `mdt_${randomUUID()}`;
const funded = ['awaiting_conditions', 'eligible', 'settled', 'settling'];
const eventsOf = (dealId: string) =>
  engine.db.select().from(dealEvents).where(eq(dealEvents.dealId, dealId));
const paymentOf = async (mandateId: string) => {
  const [row] = await engine.db
    .select()
    .from(cardPayments)
    .where(eq(cardPayments.mandateId, mandateId));
  return row as typeof cardPayments.$inferSelect;
};

describe('funding a deal with a card credential', () => {
  it('funds the deal once, however often it is retried', async () => {
    const { w, dealId } = await waitingDeal();
    const id = mandate();
    const charged = rail.cardsCharged.length;
    expect((await pay(w, dealId, id)).status).toBe('succeeded');
    await waitFor(dealId, funded);
    expect((await pay(w, dealId, id)).status).toBe('succeeded');
    expect(rail.cardsCharged.length).toBe(charged + 1);
    expect((await eventsOf(dealId)).filter((e) => e.type === 'card_funded')).toHaveLength(1);
    expect((await listDeals(w.tenantId)).rows.find((d) => d.id === dealId)?.funding).toBe('card');
  });

  it('never writes the card to either database', async () => {
    const { w, dealId } = await waitingDeal();
    const id = mandate();
    await pay(w, dealId, id);
    const stored = JSON.stringify([await paymentOf(id), await eventsOf(dealId)], (_k, v) =>
      typeof v === 'bigint' ? v.toString() : v,
    );
    expect(stored).not.toContain(CARD);

    const system = new pg.Client({ connectionString: process.env.DBOS_SYSTEM_DATABASE_URL });
    await system.connect();
    try {
      for (const [table, column] of [
        ['workflow_status', 'inputs'],
        ['operation_outputs', 'output'],
      ]) {
        const { rows } = await system.query(
          `select count(*)::int as n from dbos.${table} where ${column} like $1`,
          [`%${CARD}%`],
        );
        expect(rows[0].n).toBe(0);
      }
    } finally {
      await system.end();
    }
  });

  it('refuses an amount the mandate did not authorise, before any charge', async () => {
    const { w, dealId } = await waitingDeal();
    const charged = rail.cardsCharged.length;
    await expect(pay(w, dealId, mandate(), CARD, AMOUNT - 1n)).rejects.toThrow(/new mandate/);
    expect(rail.cardsCharged.length).toBe(charged);
  });

  it('keeps a decline on the deal, and lets a new mandate try again', async () => {
    const { w, dealId } = await waitingDeal();
    expect((await pay(w, dealId, mandate(), MockRail.DECLINED_CARD)).status).toBe('failed');
    expect((await eventsOf(dealId)).map((e) => e.type)).toContain('card_refused');
    await waitFor(dealId, ['awaiting_funding']);

    expect((await pay(w, dealId, mandate())).status).toBe('succeeded');
    await waitFor(dealId, funded);
  });

  it('allows one payment in progress per deal, and the monitor finishes it', async () => {
    const { w, dealId } = await waitingDeal();
    rail.loseNextCardAnswer = true;
    expect((await pay(w, dealId, mandate())).status).toBe('pending');
    await expect(pay(w, dealId, mandate())).rejects.toThrow(/in progress/);
    await resolveStuckCardPayments(w.tenantId, new Date(Date.now() + 600_000));
    await waitFor(dealId, funded);
  });

  it('finishes a payment whose answer was lost from the webhook, charging once', async () => {
    const { w, dealId } = await waitingDeal();
    const id = mandate();
    const charged = rail.cardsCharged.length;
    rail.loseNextCardAnswer = true;
    expect((await pay(w, dealId, id)).status).toBe('pending');

    const { intentId } = await paymentOf(id);
    await ingestRailEvent(
      'mock',
      JSON.stringify({
        id: randomUUID(),
        type: 'card.updated',
        occurredAt: new Date().toISOString(),
        externalRef: intentId,
      }),
      {},
    );
    await waitFor(dealId, funded);
    await expect.poll(async () => (await paymentOf(id)).status).toBe('succeeded');
    expect(rail.cardsCharged.length).toBe(charged + 1);
  });

  it('gives up on a payment that never reached the network', async () => {
    const { w, dealId } = await waitingDeal();
    const id = mandate();
    await engine.db.insert(cardPayments).values({
      tenantId: w.tenantId,
      dealId,
      memberId: w.retailer,
      rail: 'mock',
      mandateId: id,
      amount: AMOUNT,
      currency: 'EUR',
    });
    await resolveStuckCardPayments(w.tenantId, new Date(Date.now() + 600_000));
    expect((await paymentOf(id)).status).toBe('failed');
  });
});

describe('when the answers disagree', () => {
  it('credits a payment closed as failed if the rail later shows it was captured', async () => {
    const { w, dealId } = await waitingDeal();
    const id = mandate();
    expect((await pay(w, dealId, id, MockRail.DECLINED_CARD)).status).toBe('failed');
    const { intentId } = await paymentOf(id);
    (rail.cardIntents.get(intentId as string) as { status: string }).status = 'succeeded';
    await ingestRailEvent(
      'mock',
      JSON.stringify({
        id: randomUUID(),
        type: 'card.updated',
        occurredAt: new Date().toISOString(),
        externalRef: intentId,
      }),
      {},
    );
    await waitFor(dealId, funded);
    await expect.poll(async () => (await paymentOf(id)).status).toBe('succeeded');
    expect(await w.available(w.retailer, 'EUR')).toBe(200n);
  });

  it('does not let a failure undo a capture', async () => {
    const { w, dealId } = await waitingDeal();
    const id = mandate();
    await pay(w, dealId, id);
    await resolveStuckCardPayments(w.tenantId, new Date(Date.now() + 600_000));
    expect((await paymentOf(id)).status).toBe('succeeded');
  });

  it('only asks for the answer when a retry comes late, and never charges', async () => {
    const { w, dealId } = await waitingDeal();
    const id = mandate();
    rail.loseNextCardAnswer = true;
    await pay(w, dealId, id);
    await engine.db
      .update(cardPayments)
      .set({ createdAt: new Date(Date.now() - 90_000) })
      .where(eq(cardPayments.mandateId, id));
    const charged = rail.cardsCharged.length;
    expect((await pay(w, dealId, id)).status).toBe('pending');
    expect(rail.cardsCharged.length).toBe(charged);
    await resolveStuckCardPayments(w.tenantId, new Date(Date.now() + 600_000));
  });

  it('does not store the body of a card webhook', async () => {
    const eventId = randomUUID();
    await ingestRailEvent(
      'mock',
      JSON.stringify({
        id: eventId,
        type: 'card.updated',
        occurredAt: new Date().toISOString(),
        card: CARD,
      }),
      {},
    );
    const [stored] = await engine.db
      .select()
      .from(railEvents)
      .where(eq(railEvents.externalId, eventId));
    expect(JSON.stringify(stored?.payload)).not.toContain(CARD);
  });
});

describe('card money on its way to the rail', () => {
  it('reconciles before it lands, and books the fee when it does', async () => {
    const { w, dealId } = await waitingDeal();
    const id = mandate();
    await pay(w, dealId, id);

    const before = await reconcile(w.tenantId, 'mock');
    expect(before.breaks.filter((b) => b.currency === 'EUR')).toEqual([]);

    const row = await paymentOf(id);
    rail.settleCard(row.intentId as string, 150n);
    const after = await reconcile(w.tenantId, 'mock');
    expect(after.breaks.filter((b) => b.externalRef === row.attemptRef)).toEqual([]);
    expect(after.breaks.filter((b) => b.kind === 'balance_mismatch')).toEqual([]);
    expect((await paymentOf(id)).settledAt).toBeTruthy();
    const fees = await engine.db
      .select()
      .from(ledgerTransfers)
      .where(and(eq(ledgerTransfers.tenantId, w.tenantId), eq(ledgerTransfers.kind, 'card_fee')));
    expect(fees.map((f) => f.amount)).toEqual([150n]);
    expect(await w.available(w.retailer, 'EUR')).toBe(50n);
  });
});
