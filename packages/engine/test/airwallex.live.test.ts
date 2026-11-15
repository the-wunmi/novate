import { randomUUID } from 'node:crypto';
import { existsSync } from 'node:fs';
import { settlementInstructions } from '@novate/db';
import { type ProgramSpecInput, presetInputs } from '@novate/policy';
import { AirwallexRail } from '@novate/rails';
import { eq } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  deposit,
  type Engine,
  provisionMember,
  publishProgram,
  recordRailOpening,
  runCycle,
  runReconciliation,
  submitFact,
} from '../src/index.ts';
import { boot, eur, gbp, makeWorld, shutdown, type World, waitFor } from './harness.ts';

const envFile = new URL('../../../.env', import.meta.url).pathname;
if (existsSync(envFile)) process.loadEnvFile(envFile);
const { AIRWALLEX_CLIENT_ID, AIRWALLEX_API_KEY } = process.env;
const live = Boolean(AIRWALLEX_CLIENT_ID && AIRWALLEX_API_KEY);

/** The end state against the real Airwallex sandbox. Skipped until keys are in `.env`. */
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
  const netted: ProgramSpecInput = {
    ...presetInputs.netSettlement,
    overrides: [],
    settlement: { ...settlement, fundingWindow: '2m' },
  };

  const provision = (w: World, memberId: string, currency: string, countryCode: string) =>
    provisionMember(w.tenantId, memberId, {
      idempotencyKey: randomUUID(),
      rail: 'airwallex',
      countryCode,
      currency,
      transferMethods: ['LOCAL'],
      beneficiary: {
        entity_type: 'COMPANY',
        company_name: `novate test ${memberId.slice(0, 6)}`,
        address: {
          country_code: 'NL',
          city: 'Amsterdam',
          street_address: 'Damrak 1',
          postcode: '1012LG',
        },
        bank_details: {
          account_currency: 'EUR',
          account_name: 'novate test',
          bank_country_code: 'NL',
          iban: 'NL91ABNA0417164300',
          swift_code: 'ABNANL2A',
        },
      },
    });

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
    engine = await boot(rail);
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
    await provision(w, w.brand, 'GBP', 'GB');
    await provision(w, w.retailer, 'EUR', 'DE');
    await provision(w, w.supplier, 'EUR', 'DE');
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
    expect(await runReconciliation(w.tenantId, 'airwallex')).toMatchObject({ status: 'clean' });

    await publishProgram(w.tenantId, { key: 'net', spec: netted });
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
    expect(await runReconciliation(w.tenantId, 'airwallex')).toMatchObject({ status: 'clean' });
  }, 600_000);
});
