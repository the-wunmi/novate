import { createHmac, randomUUID } from 'node:crypto';
import { ClaudeDecisionAgent, ClaudeDocumentReader, type ModelClient } from '@novate/agents';
import { fxSellAmount } from '@novate/core';
import { type ProgramSpecInput, presetInputs } from '@novate/policy';
import { AirwallexRail } from '@novate/rails';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { FakeAirwallex } from '../../rails/test/fake-airwallex.ts';
import {
  dealDetail,
  ingestRailEvent,
  publishProgram,
  runCycle,
  runReconciliation,
  setMemberRailRefs,
  submitDocument,
  submitFact,
} from '../src/index.ts';
import { boot, brain, eur, gbp, makeWorld, notified, shutdown, waitFor } from './harness.ts';

/**
 * The end state, with a stand-in for Airwallex: every rail call, webhook and agent goes through the
 * production code path. Only the HTTP server and the model's replies are replaced.
 */
const SECRET = 'whsec-test';
const fake = new FakeAirwallex();
const rail = new AirwallexRail({
  clientId: 'c',
  apiKey: 'k',
  webhookSecret: SECRET,
  fetch: fake.fetch,
});

const decisions: string[] = [];
const riskModel: ModelClient = {
  model: 'stub-risk',
  async complete(r) {
    const text = JSON.stringify(r.content);
    const kind = /Case kind: (\w+)/.exec(text)?.[1];
    decisions.push(kind as string);
    const blank = {
      codes: null,
      note: null,
      bps: null,
      amount: null,
      reason: null,
      agent_id: null,
      member_id: null,
      plan_id: null,
      lines: null,
    };
    const action = kind === 'frozen' ? 'cancel' : kind === 'held' ? 'waive' : 'escalate';
    return {
      output: {
        ...blank,
        action_type: action,
        note: action === 'escalate' ? 'n' : null,
        rationale: `decided ${kind}`,
      },
      metadata: {},
    };
  },
};

/** Reads the fixture format `field=value` lines, standing in for reading a real PDF. */
const readerModel: ModelClient = {
  model: 'stub-reader',
  async complete(r) {
    const text = (r.content[0] as { text: string }).text;
    const get = (k: string) => new RegExp(`${k}=([^\\s<]+)`).exec(text)?.[1] ?? null;
    const q = get('quantity');
    return {
      output: {
        total_amount: get('total'),
        currency: get('currency'),
        quantity: q === null ? null : Number(q),
        shipment_date: get('shipped'),
        issues: [],
      },
      metadata: {},
    };
  },
};

beforeAll(async () => {
  await boot(rail, [], { documentReader: new ClaudeDocumentReader(readerModel) });
  brain.current = new ClaudeDecisionAgent(riskModel);
});
afterAll(() => shutdown());

const trade: ProgramSpecInput = {
  ...presetInputs.tradeAssurance,
  overrides: [],
  // The tenant lets agents decide up to €200,000, which covers the frozen €90,000 order.
  decisions: { ceiling: { EUR: 20_000_000 } },
  settlement: { netting: 'multilateral', rail: 'airwallex', confirmWithin: '1h' },
};
const netted: ProgramSpecInput = {
  ...presetInputs.netSettlement,
  overrides: [],
  settlement: {
    netting: 'multilateral',
    rail: 'airwallex',
    fundingWindow: '30s',
    confirmWithin: '1h',
  },
};

const webhook = async (name: string, object: Record<string, unknown>) => {
  const body = JSON.stringify({
    id: randomUUID(),
    name,
    created_at: new Date().toISOString(),
    data: { object },
  });
  const ts = String(Date.now());
  const signature = createHmac('sha256', SECRET)
    .update(ts + body)
    .digest('hex');
  await ingestRailEvent('airwallex', body, { 'x-timestamp': ts, 'x-signature': signature });
};

/** Every 100ms, anything in flight lands and Airwallex tells us by signed webhook. */
const paying = setInterval(() => {
  for (const [id, t] of fake.transfers) {
    if (t.status !== 'PROCESSING') continue;
    fake.setTransfer(id, 'PAID');
    void webhook('payout.transfer.paid', { id });
  }
}, 100);
afterAll(() => clearInterval(paying));

describe('end state', () => {
  it('runs the mug scenario unattended, then net settlement under a different program', async () => {
    const before = notified.length;
    const w = await makeWorld(rail as never, { 'trade-assurance': trade });
    const accounts: Record<string, string> = {};
    for (const m of [w.brand, w.supplier, w.retailer]) {
      accounts[m] = `ga-${m}`;
      await setMemberRailRefs(w.tenantId, m, {
        airwallex_deposit_account: accounts[m],
        airwallex_beneficiary: `ben-${m}`,
      });
    }
    const deposit = async (member: string, currency: string, amount: bigint) => {
      const major = Number(amount) / 100;
      const id = fake.deposit(currency, major);
      await webhook('deposit.settled', {
        id,
        global_account_id: accounts[member],
        amount: major,
        currency,
      });
    };
    const docs = async (
      dealId: string,
      total: string,
      quantity: number,
      shipped: string,
      seller: string,
    ) => {
      const send = (type: string, text: string) =>
        submitDocument(dealId, w.asMember(seller), { type, content: { kind: 'text', text } });
      await send('commercial_invoice', `total=${total} currency=EUR quantity=${quantity}`);
      await send('packing_list', `quantity=${quantity}`);
      await send('bill_of_lading', `shipped=${shipped}`);
    };

    await deposit(w.brand, 'GBP', gbp('15000'));
    await deposit(w.retailer, 'EUR', eur('11000'));
    await deposit(w.supplier, 'EUR', eur('2000'));
    await expect.poll(() => w.available(w.supplier, 'EUR'), { timeout: 15_000 }).toBe(eur('2000'));
    await expect.poll(() => w.available(w.brand, 'GBP'), { timeout: 15_000 }).toBe(gbp('15000'));
    await expect.poll(() => w.available(w.retailer, 'EUR'), { timeout: 15_000 }).toBe(eur('11000'));

    // 1. The two deals of the week, with documents read and the inspection reported.
    const buy = await w.deal({ buyer: 'brand', seller: 'supplier', quantity: 1_000, price: '14' });
    const sell = await w.deal({ buyer: 'retailer', seller: 'brand', quantity: 600, price: '15' });
    await waitFor(buy.id, ['awaiting_conditions']);
    await waitFor(sell.id, ['awaiting_conditions']);
    await docs(buy.id, '14000.00', 1_000, '2026-11-03', w.supplier);
    await submitFact(buy.id, w.inspector, {
      kind: 'inspection',
      type: 'third_party',
      data: { inspected: 1_000, passed: 920 },
    });
    await docs(sell.id, '9000.00', 600, '2026-11-02', w.brand);
    await submitFact(sell.id, w.inspector, {
      kind: 'inspection',
      type: 'third_party',
      data: { passRate: 1 },
    });
    expect((await waitFor(buy.id, ['eligible'])).releaseAmount).toBe(eur('12880'));
    await waitFor(sell.id, ['eligible']);

    // 2. A 10x order is frozen. The risk agent cancels it and nobody is asked.
    const big = await w.deal({ buyer: 'retailer', seller: 'brand', quantity: 6_000, price: '15' });
    await waitFor(big.id, ['cancelled']);

    // 3. A shipment outside tolerance is held. The risk agent waives it.
    const late = await w.deal({
      buyer: 'retailer',
      seller: 'supplier',
      quantity: 100,
      price: '15',
    });
    await waitFor(late.id, ['awaiting_conditions']);
    await docs(late.id, '1500.00', 100, '2026-11-20', w.supplier);
    await submitFact(late.id, w.inspector, {
      kind: 'inspection',
      type: 'third_party',
      data: { passRate: 1 },
    });
    await waitFor(late.id, ['eligible']);

    // 4. Everything settles in one cycle, on one conversion.
    const cycle = await runCycle(w.tenantId);
    expect(cycle.status).toBe('settled');
    await waitFor(buy.id, ['settled']);
    await waitFor(sell.id, ['settled']);
    await waitFor(late.id, ['settled']);

    const conversions = fake.calls.filter((c) => c.path === '/api/v1/fx/conversions/create');
    expect(conversions.map((c) => (c.body as { buy_amount: string }).buy_amount)).toEqual([
      '3880.00',
    ]);
    const paid = fake.calls
      .filter((c) => c.path === '/api/v1/transfers/create')
      .map((c) => (c.body as { transfer_amount: string }).transfer_amount);
    expect(paid).toEqual(['14380.00']);

    const sold = fxSellAmount(eur('3880'), 115_000_000n, 'GBP', 'EUR');
    expect(await w.available(w.brand, 'GBP')).toBe(gbp('15000') - sold);

    // 5. The ledger agrees with what the rail holds. No request ids over Airwallex's limits.
    const recon = await runReconciliation(w.tenantId, 'airwallex');
    expect(recon.breaks).toEqual([]);
    for (const c of fake.calls) {
      const id = (c.body as { request_id?: string } | undefined)?.request_id;
      if (id) expect(id.length).toBeLessThanOrEqual(50);
    }

    // 6. Switch programs. Same tenant, same agents, same risk brain, no prefunding.
    await publishProgram(w.tenantId, { key: 'net', spec: netted });
    const nBuy = await w.deal({
      program: 'net',
      buyer: 'retailer',
      seller: 'supplier',
      quantity: 50,
      price: '10',
    });
    const nSell = await w.deal({
      program: 'net',
      buyer: 'brand',
      seller: 'supplier',
      quantity: 100,
      price: '5',
    });
    await waitFor(nBuy.id, ['awaiting_conditions']);
    await waitFor(nSell.id, ['awaiting_conditions']);
    await submitFact(nBuy.id, w.asMember(w.retailer), {
      kind: 'acceptance',
      type: 'buyer',
      data: {},
    });
    await submitFact(nSell.id, w.asMember(w.brand), {
      kind: 'acceptance',
      type: 'buyer',
      data: {},
    });
    await waitFor(nBuy.id, ['eligible']);
    await waitFor(nSell.id, ['eligible']);

    const pending = runCycle(w.tenantId);
    await waitFor(nSell.id, ['settling']);
    // The brand holds no euros, so the cycle waits until it sends some in.
    await new Promise((r) => setTimeout(r, 300));
    await deposit(w.brand, 'EUR', eur('500'));
    expect((await pending).status).toBe('settled');
    await waitFor(nBuy.id, ['settled']);
    await waitFor(nSell.id, ['settled']);
    expect((await dealDetail(nBuy.id, w.platform)).deal.fundingCurrency).toBe('EUR');

    expect(await runReconciliation(w.tenantId, 'airwallex')).toMatchObject({ status: 'clean' });

    // Nobody was asked about anything, and the model saw exactly the exceptions.
    expect(notified.length).toBe(before);
    expect(decisions).toEqual(['frozen', 'held']);
  });
});
