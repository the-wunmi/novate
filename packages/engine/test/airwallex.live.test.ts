import { settlementInstructions } from '@novate/db';
import { type ProgramSpecInput, presetInputs } from '@novate/policy';
import { AirwallexRail } from '@novate/rails';
import { eq } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  deposit,
  type Engine,
  publishProgram,
  recordRailOpening,
  runCycle,
  submitFact,
} from '../src/index.ts';
import {
  boot,
  eur,
  gbp,
  liveAccounts,
  makeWorld,
  netProgram,
  reconcile,
  shutdown,
  type World,
  waitFor,
} from './harness.ts';

const { AIRWALLEX_CLIENT_ID, AIRWALLEX_API_KEY } = process.env;
// Real sandbox money, so only `pnpm test:live` runs it.
const live = Boolean(AIRWALLEX_CLIENT_ID && AIRWALLEX_API_KEY);

/** The end state against the real Airwallex sandbox. Run by `pnpm test:live` with keys in `.env`. */
describe.skipIf(!live)('mug scenario on the Airwallex sandbox (live)', () => {
  const rail = new AirwallexRail({
    clientId: AIRWALLEX_CLIENT_ID as string,
    apiKey: AIRWALLEX_API_KEY as string,
    webhookSecret: process.env.AIRWALLEX_WEBHOOK_SECRET ?? 'unused',
  });
  let engine: Engine;
  let paying: NodeJS.Timeout;

  const settlement = { netting: 'multilateral', rail: 'airwallex', confirmWithin: '1h' } as const;
  const trade: ProgramSpecInput = { ...presetInputs.tradeAssurance, overrides: [], settlement };
  const netted = netProgram({ settlement: { ...settlement, fundingWindow: '2m' } });

  /** Simulate money arriving, then credit the ledger as the webhook would. */
  async function fund(w: World, memberId: string, currency: string, amount: bigint) {
    const members = await engine.db.query.members.findFirst({
      where: (m, { eq: equals }) => equals(m.id, memberId),
    });
    const globalAccountId = members?.railRefs.airwallex_deposit_account as string;
    const { id } = await rail.simulateDeposit({ globalAccountId, amount, currency });
    await deposit(w.tenantId, { memberId, currency, amount, rail: 'airwallex', externalRef: id });
  }

  beforeAll(async () => {
    // A real rail is retried and polled at production pace.
    engine = await boot(rail, [], { pace: 1 });
    // Sandbox transfers stay in flight until told otherwise, and must pass through SENT.
    paying = setInterval(async () => {
      const inFlight = await engine.db
        .select()
        .from(settlementInstructions)
        .where(eq(settlementInstructions.status, 'submitted'));
      for (const i of inFlight) {
        if (!i.externalRef) continue;
        await rail.simulateTransfer(i.externalRef, 'SENT').catch(() => undefined);
        await rail
          .simulateTransfer(i.externalRef, 'PAID')
          .catch((err) => console.log('could not mark paid', i.externalRef, String(err)));
      }
    }, 3_000);
  }, 120_000);
  afterAll(async () => {
    clearInterval(paying);
    await shutdown();
  });

  it('settles trade assurance, then net settlement after a program switch', async () => {
    const w = await makeWorld(rail as never, { 'trade-assurance': trade });
    await recordRailOpening(w.tenantId, 'airwallex');
    await liveAccounts(w, rail, w.brand, 'brand', 'GBP', 'GB');
    await liveAccounts(w, rail, w.retailer, 'retailer', 'EUR', 'DE');
    await liveAccounts(w, rail, w.supplier, 'supplier', 'EUR', 'DE');
    await fund(w, w.brand, 'GBP', gbp('15000'));
    await fund(w, w.retailer, 'EUR', eur('9000'));
    await fund(w, w.supplier, 'EUR', eur('1000'));

    const buy = await w.deal({ buyer: 'brand', seller: 'supplier', quantity: 1_000, price: '14' });
    const sell = await w.deal({ buyer: 'retailer', seller: 'brand', quantity: 600, price: '15' });
    await waitFor(buy.id, ['awaiting_conditions'], 60_000);
    await waitFor(sell.id, ['awaiting_conditions'], 60_000);
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
    await fund(w, w.retailer, 'EUR', eur('500'));
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
  }, 600_000);
});
