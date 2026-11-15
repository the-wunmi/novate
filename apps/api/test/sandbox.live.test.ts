import { serve } from '@hono/node-server';
import { ClaudeDecisionAgent, ClaudeModelClient } from '@novate/agents';
import { freshDatabasePair } from '@novate/db/test-databases';
import {
  type Engine,
  publishProgram,
  recordRailOpening,
  runCycle,
  submitFact,
} from '@novate/engine';
import { type ProgramSpecInput, presetInputs } from '@novate/policy';
import { AirwallexRail } from '@novate/rails';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  boot,
  eur,
  gbp,
  liveAccounts,
  makeWorld,
  reconcile,
  shutdown,
  type World,
  waitFor,
} from '../../../packages/engine/test/harness.ts';
import { createApp } from '../src/app.ts';

/**
 * Everything real at once: Airwallex's sandbox, its webhooks through a public tunnel to port 4000,
 * and Claude deciding a case. Run `pnpm webhook:register <tunnel>` first, then
 * `pnpm test:live`.
 * Spends a little on the model.
 */
describe('all of it, for real', () => {
  const rail = new AirwallexRail({
    clientId: process.env.AIRWALLEX_CLIENT_ID as string,
    apiKey: process.env.AIRWALLEX_API_KEY as string,
    webhookSecret: process.env.AIRWALLEX_WEBHOOK_SECRET as string,
  });
  const settlement = { netting: 'multilateral', rail: 'airwallex', confirmWithin: '1h' } as const;
  const trade: ProgramSpecInput = {
    ...presetInputs.tradeAssurance,
    overrides: [],
    // The tenant lets agents decide up to EUR 200,000, which covers the frozen order.
    decisions: { ceiling: { EUR: 20_000_000 } },
    settlement,
  };
  const netted: ProgramSpecInput = {
    ...presetInputs.netSettlement,
    overrides: [],
    settlement: { ...settlement, fundingWindow: '2m' },
  };

  let engine: Engine;
  let paying: NodeJS.Timeout;
  let server: ReturnType<typeof serve>;
  const started = new Date();

  const accounts = new Map<string, string>();
  async function provision(
    w: World,
    memberId: string,
    slug: string,
    currency: 'EUR' | 'GBP',
    countryCode: string,
  ) {
    const refs = await liveAccounts(w, rail, memberId, slug, currency, countryCode);
    accounts.set(memberId, refs.airwallex_deposit_account as string);
  }

  /** Money arrives on the rail and nothing else happens: only the webhook can credit it. */
  async function send(w: World, memberId: string, currency: 'EUR' | 'GBP', amount: bigint) {
    const before = await w.available(memberId, currency);
    const { id } = await rail.simulateDeposit({
      globalAccountId: accounts.get(memberId) as string,
      amount,
      currency,
    });
    await expect
      .poll(() => w.available(memberId, currency), { timeout: 90_000, interval: 500 })
      .toBe(before + amount);
    return id;
  }

  beforeAll(async () => {
    // Its own databases: the members it makes share Global Accounts with every earlier run.
    engine = await boot(rail, [], {
      ...(await freshDatabasePair('novate_test_sandbox_live')),
      decisionAgent: new ClaudeDecisionAgent(new ClaudeModelClient()),
      // A real rail and model are retried and polled at production pace.
      pace: 1,
    });
    server = serve({ fetch: createApp({ isOperator: async () => false }).fetch, port: 4000 });
    paying = setInterval(async () => {
      const inFlight = await engine.db.query.settlementInstructions.findMany({
        where: (i, { and, eq }) => and(eq(i.status, 'submitted'), eq(i.rail, 'airwallex')),
      });
      for (const i of inFlight) {
        if (!i.externalRef) continue;
        await rail.simulateTransfer(i.externalRef, 'SENT').catch(() => undefined);
        await rail.simulateTransfer(i.externalRef, 'PAID').catch(() => undefined);
      }
    }, 3_000);
  }, 120_000);

  afterAll(async () => {
    clearInterval(paying);
    server?.close();
    await shutdown();
  });

  it('funds by webhook, lets Claude decide, settles, and handles a payout coming back', async () => {
    const w = await makeWorld(rail as never, { 'trade-assurance': trade });
    await recordRailOpening(w.tenantId, 'airwallex');
    await provision(w, w.brand, 'brand', 'GBP', 'GB');
    await provision(w, w.retailer, 'retailer', 'EUR', 'DE');
    await provision(w, w.supplier, 'supplier', 'EUR', 'DE');

    await send(w, w.brand, 'GBP', gbp('15000'));
    const lastDeposit = await send(w, w.retailer, 'EUR', eur('9000'));
    await send(w, w.supplier, 'EUR', eur('1000'));

    // A deposit a webhook missed would be found by polling.
    const polled = await rail.pollEvents(BigInt(started.getTime()));
    expect(polled.events.map((e) => e.externalRef)).toContain(lastDeposit);

    const buy = await w.deal({ buyer: 'brand', seller: 'supplier', quantity: 1_000, price: '14' });
    const sell = await w.deal({ buyer: 'retailer', seller: 'brand', quantity: 600, price: '15' });
    await waitFor(buy.id, ['awaiting_conditions'], 60_000);
    await waitFor(sell.id, ['awaiting_conditions'], 60_000);

    // Ten times the usual order is frozen, and a model decides what happens to it.
    const big = await w.deal({ buyer: 'retailer', seller: 'brand', quantity: 6_000, price: '15' });
    const decided = async () => {
      const cases = await engine.db.query.decisionCases.findMany({
        where: (c, { eq }) => eq(c.subjectId, big.id),
      });
      const records = await engine.db.query.decisionRecords.findMany({
        where: (r, { inArray }) =>
          inArray(
            r.caseId,
            cases.map((c) => c.id),
          ),
      });
      return records;
    };
    await expect
      .poll(async () => (await decided()).length, { timeout: 180_000, interval: 1_000 })
      .toBeGreaterThan(0);
    const [record] = await decided();
    console.log('the model decided', record?.action, record?.rationale);
    expect(record?.deciderType).toBe('model');
    expect(record?.deciderId).toMatch(/claude/);

    await w.pass(buy.id, {
      amount: eur('14000'),
      quantity: 1_000,
      shipped: '2026-11-03',
      pass: { inspected: 1_000, passed: 920 },
    });
    await w.pass(sell.id, { amount: eur('9000'), quantity: 600 });
    await waitFor(buy.id, ['eligible'], 60_000);
    await waitFor(sell.id, ['eligible'], 60_000);
    expect((await runCycle(w.tenantId)).status).toBe('settled');
    await waitFor(buy.id, ['settled'], 120_000);
    expect(await reconcile(w.tenantId, 'airwallex')).toMatchObject({ status: 'clean' });

    await publishProgram(w.tenantId, w.platform, { key: 'net', spec: netted });
    await send(w, w.retailer, 'EUR', eur('500'));
    const net = await w.deal({
      program: 'net',
      buyer: 'retailer',
      seller: 'supplier',
      quantity: 100,
      price: '5',
    });
    await waitFor(net.id, ['awaiting_conditions'], 60_000);
    await submitFact(net.id, w.asMember(w.retailer), {
      kind: 'acceptance',
      type: 'buyer',
      data: {},
    });
    await waitFor(net.id, ['eligible'], 60_000);
    expect((await runCycle(w.tenantId)).status).toBe('settled');
    await waitFor(net.id, ['settled'], 120_000);
    expect(await reconcile(w.tenantId, 'airwallex')).toMatchObject({ status: 'clean' });

    const heard = await engine.db.query.railEvents.findMany({
      where: (e, { and, eq, gte }) => and(eq(e.rail, 'airwallex'), gte(e.createdAt, started)),
    });
    console.log(
      'webhooks heard',
      heard
        .map((e) => `${e.type}:${e.outcome}`)
        .sort()
        .join(' '),
    );
    expect(heard.some((e) => e.type === 'deposit.settled')).toBe(true);
    expect(heard.some((e) => e.type === 'payment.confirmed')).toBe(true);
    expect(heard.some((e) => e.type === 'fx.confirmed')).toBe(true);

    // Airwallex can fail a payment it already reported as paid.
    const paid = await engine.db.query.settlementInstructions.findFirst({
      where: (i, { and, eq }) =>
        and(
          eq(i.tenantId, w.tenantId),
          eq(i.status, 'confirmed'),
          eq(i.memberId, w.supplier),
          eq(i.direction, 'payout'),
        ),
    });
    const wallet = await w.available(w.supplier, 'EUR');
    await rail.simulateTransfer(paid?.externalRef as string, 'FAILED');
    await expect
      .poll(() => w.available(w.supplier, 'EUR'), { timeout: 90_000, interval: 500 })
      .toBe(wallet + (paid?.amount as bigint));
    expect(await reconcile(w.tenantId, 'airwallex')).toMatchObject({ status: 'clean' });
  }, 900_000);
});
