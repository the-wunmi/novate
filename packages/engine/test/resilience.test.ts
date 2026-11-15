import { DBOS } from '@dbos-inc/dbos-sdk';
import { type ProgramSpecInput, presetInputs } from '@novate/policy';
import { MockRail } from '@novate/rails';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  balances,
  contributeToDefaultFund,
  dealDetail,
  deposit,
  ingestRailEvent,
  monitorWorkflow,
  runCycle,
  settleDueGroups,
  submitFact,
  tenantStatus,
} from '../src/index.ts';
import { boot, brain, eur, gbp, makeWorld, shutdown, waitFor } from './harness.ts';

const flaky = new Set<string>();
const flakyPayout = new Set<string>();
const main = new MockRail();
const noPull = new MockRail({ name: 'nopull', pull: false });
const failNext = new Set<string>();
const failing = new MockRail({
  name: 'failing',
  failNextPayoutFor: failNext,
  failCollectionsFor: flaky,
  failPayoutsFor: flakyPayout,
});
const slow = new MockRail({ name: 'slow', async: true, holdUntilSettled: true });
const moving = new MockRail({ name: 'moving' });
const puller = new MockRail({ name: 'puller', pullToLock: true });

beforeAll(() => boot(main, [noPull, failing, slow, moving, puller]));
afterAll(() => shutdown());

const net = (over: Partial<ProgramSpecInput> = {}, railName = 'mock'): ProgramSpecInput => ({
  ...presetInputs.netSettlement,
  overrides: [],
  settlement: { netting: 'multilateral', rail: railName, fundingWindow: '2s', confirmWithin: '1h' },
  ...over,
});

const accept = (w: Awaited<ReturnType<typeof makeWorld>>, dealId: string, buyer: string) =>
  submitFact(dealId, w.asMember(buyer), { kind: 'acceptance', type: 'buyer', data: {} });

describe('net settlement', () => {
  it('runs the same flow under a different program, paying only the difference', async () => {
    const w = await makeWorld(main, { net: net() });
    await w.fund(w.brand, 'EUR', eur('3880'));
    const buy = await w.deal({
      program: 'net',
      buyer: 'brand',
      seller: 'supplier',
      quantity: 920,
      price: '14',
    });
    const sell = await w.deal({
      program: 'net',
      buyer: 'retailer',
      seller: 'brand',
      quantity: 600,
      price: '15',
    });
    await waitFor(buy.id, ['awaiting_conditions']);
    await waitFor(sell.id, ['awaiting_conditions']);
    await accept(w, buy.id, w.brand);
    await accept(w, sell.id, w.retailer);
    await waitFor(buy.id, ['eligible']);
    await waitFor(sell.id, ['eligible']);

    await w.fund(w.retailer, 'EUR', eur('9000'));
    const cycle = await runCycle(w.tenantId);
    expect(cycle.status).toBe('settled');
    await waitFor(buy.id, ['settled']);
    expect(await w.available(w.brand, 'EUR')).toBe(0n);
    expect(await w.available(w.retailer, 'EUR')).toBe(0n);
  });
});

describe('funding', () => {
  it('waits for a deposit when the rail cannot pull', async () => {
    const w = await makeWorld(noPull, {
      net: net({ settlement: { rail: 'nopull', fundingWindow: '30s' } }),
    });
    const d = await w.deal({
      program: 'net',
      buyer: 'retailer',
      seller: 'supplier',
      quantity: 10,
      price: '15',
    });
    await waitFor(d.id, ['awaiting_conditions']);
    await accept(w, d.id, w.retailer);
    await waitFor(d.id, ['eligible']);
    const pending = runCycle(w.tenantId);
    await waitFor(d.id, ['settling']);
    await new Promise((r) => setTimeout(r, 300));
    await w.fund(w.retailer, 'EUR', eur('150'));
    expect((await pending).status).toBe('settled');
    await waitFor(d.id, ['settled']);
  });
});

describe('defaults', () => {
  it('agent risk: a defaulter drops out and everyone else still settles', async () => {
    brain.current = undefined;
    const w = await makeWorld(failing, { net: net({}, 'failing') });
    flaky.add(w.retailer);
    await w.fund(w.brand, 'EUR', eur('140'));

    const good = await w.deal({
      program: 'net',
      buyer: 'brand',
      seller: 'supplier',
      quantity: 10,
      price: '14',
    });
    const bad = await w.deal({
      program: 'net',
      buyer: 'retailer',
      seller: 'supplier',
      quantity: 10,
      price: '15',
    });
    for (const [d, m] of [
      [good, w.brand],
      [bad, w.retailer],
    ] as const) {
      await waitFor(d.id, ['awaiting_conditions']);
      await accept(w, d.id, m);
      await waitFor(d.id, ['eligible']);
    }

    const cycle = await runCycle(w.tenantId);
    expect(cycle.failures.map((f) => f.memberId)).toEqual([w.retailer]);
    await waitFor(good.id, ['settled']);
    const deferred = await waitFor(bad.id, ['eligible']);
    expect(deferred.status).toBe('eligible');
    const { obligations } = await dealDetail(bad.id, w.platform);
    expect(obligations[0]?.status).toBe('eligible');
    for (const b of await balances(w.tenantId, w.supplier)) {
      if (b.code.endsWith(':settlement')) expect(b.balance).toBe(0n);
    }
  });

  it('principal risk: creditors are paid and the house books the loss', async () => {
    brain.current = undefined;
    const w = await makeWorld(failing, {
      net: net({ risk: { bearer: 'principal' } }, 'failing'),
    });
    flaky.add(w.retailer);
    // The house has its own cash on this rail to pay out with.
    await deposit(w.tenantId, {
      memberId: w.brand,
      currency: 'EUR',
      amount: eur('1000'),
      rail: 'failing',
      externalRef: `capital-${w.tenantId}`,
    });
    failing.simulateDeposit('EUR', eur('1000'), `capital-${w.tenantId}`);

    const d = await w.deal({
      program: 'net',
      buyer: 'retailer',
      seller: 'supplier',
      quantity: 10,
      price: '15',
    });
    await waitFor(d.id, ['awaiting_conditions']);
    await accept(w, d.id, w.retailer);
    await waitFor(d.id, ['eligible']);
    const cycle = await runCycle(w.tenantId);
    expect(cycle.status).toBe('settled');
    await waitFor(d.id, ['settled']);
    const payouts = failing.log.filter(
      (l) => l.direction === 'payout' && l.req.member.id === w.supplier,
    );
    expect(payouts.at(-1)?.req.amount).toBe(eur('150'));
  });

  const retryOnce = (kind = 'settlement_exception') => ({
    ceiling: { EUR: 5_000_000 },
    rules: [
      {
        id: 'once',
        case: kind as 'settlement_exception',
        when: 'attempt == 0',
        action: { type: 'retry_settlement' },
        reason: 'try again',
      },
    ],
  });

  it('the mutual default fund covers a default before the house loses anything', async () => {
    brain.current = undefined;
    const w = await makeWorld(failing, {
      net: net({ risk: { bearer: 'principal', defaultFund: true } }, 'failing'),
    });
    flaky.add(w.retailer);
    await w.fund(w.brand, 'EUR', eur('1000'));
    await contributeToDefaultFund(w.tenantId, {
      memberId: w.brand,
      currency: 'EUR',
      amount: eur('1000'),
      idempotencyKey: 'brand-1',
    });
    const d = await w.deal({
      program: 'net',
      buyer: 'retailer',
      seller: 'supplier',
      quantity: 10,
      price: '15',
    });
    await waitFor(d.id, ['awaiting_conditions']);
    await accept(w, d.id, w.retailer);
    await waitFor(d.id, ['eligible']);
    expect((await runCycle(w.tenantId)).status).toBe('settled');
    await waitFor(d.id, ['settled']);
    const fund = (await balances(w.tenantId, w.brand)).find((b) =>
      b.code.endsWith(':default_fund'),
    );
    expect(fund?.balance).toBe(eur('850'));
  });

  it('refunds a deal held back by a suspended member once the cure window passes', async () => {
    brain.current = undefined;
    const w = await makeWorld(failing, {
      net: net({ settlement: { rail: 'failing', fundingWindow: '1s', cureWindow: '1s' } }),
    });
    flaky.add(w.retailer);
    const d = await w.deal({
      program: 'net',
      buyer: 'retailer',
      seller: 'supplier',
      quantity: 10,
      price: '15',
    });
    await waitFor(d.id, ['awaiting_conditions']);
    await accept(w, d.id, w.retailer);
    await waitFor(d.id, ['eligible']);
    await runCycle(w.tenantId);
    await waitFor(d.id, ['eligible']);
    await new Promise((r) => setTimeout(r, 1_200));
    const summary = await (await DBOS.startWorkflow(monitorWorkflow)(w.tenantId)).getResult();
    expect(summary.dealsRefunded).toBe(1);
    await waitFor(d.id, ['refunded']);
  });

  it('a retried collection only asks for what is still owed', async () => {
    brain.current = undefined;
    const w = await makeWorld(failing, { net: net({ decisions: retryOnce() }, 'failing') });
    flaky.add(w.retailer);
    await w.fund(w.retailer, 'EUR', eur('40'));
    const d = await w.deal({
      program: 'net',
      buyer: 'retailer',
      seller: 'supplier',
      quantity: 10,
      price: '10',
    });
    await waitFor(d.id, ['awaiting_conditions']);
    await accept(w, d.id, w.retailer);
    await waitFor(d.id, ['eligible']);

    const pending = runCycle(w.tenantId);
    await expect
      .poll(() => failing.log.some((l) => l.req.member.id === w.retailer), { timeout: 15_000 })
      .toBe(true);
    flaky.delete(w.retailer);
    expect((await pending).status).toBe('settled');
    const asks = failing.log.filter(
      (l) => l.direction === 'collect' && l.req.member.id === w.retailer,
    );
    expect(asks.map((a) => a.req.amount)).toEqual([eur('60'), eur('60')]);
  });

  it('a retried payout uses a new instruction and lands', async () => {
    brain.current = undefined;
    const w = await makeWorld(failing, { net: net({ decisions: retryOnce() }, 'failing') });
    failNext.add(w.supplier);
    await w.fund(w.brand, 'EUR', eur('140'));
    const d = await w.deal({
      program: 'net',
      buyer: 'brand',
      seller: 'supplier',
      quantity: 10,
      price: '14',
    });
    await waitFor(d.id, ['awaiting_conditions']);
    await accept(w, d.id, w.brand);
    await waitFor(d.id, ['eligible']);
    expect((await runCycle(w.tenantId)).status).toBe('settled');
    await waitFor(d.id, ['settled']);
    const paid = failing.log.filter(
      (l) => l.direction === 'payout' && l.req.member.id === w.supplier,
    );
    expect(paid.map((p) => p.result.status)).toEqual(['failed', 'confirmed']);
    expect(await w.available(w.supplier, 'EUR')).toBe(0n);
  });

  it('a failed payout goes to the member’s wallet and does not suspend them', async () => {
    brain.current = undefined;
    const w = await makeWorld(failing, { net: net({}, 'failing') });
    flakyPayout.add(w.supplier);
    await w.fund(w.brand, 'EUR', eur('140'));
    const d = await w.deal({
      program: 'net',
      buyer: 'brand',
      seller: 'supplier',
      quantity: 10,
      price: '14',
    });
    await waitFor(d.id, ['awaiting_conditions']);
    await accept(w, d.id, w.brand);
    await waitFor(d.id, ['eligible']);
    await runCycle(w.tenantId);
    await waitFor(d.id, ['settled']);
    expect(await w.available(w.supplier, 'EUR')).toBe(eur('140'));
  });
});

describe('rail truth', () => {
  it('never treats an in-flight payment as failed, and confirms when it lands', async () => {
    brain.current = undefined;
    const w = await makeWorld(slow, { net: net({}, 'slow') });
    await w.fund(w.brand, 'EUR', eur('140'));
    const d = await w.deal({
      program: 'net',
      buyer: 'brand',
      seller: 'supplier',
      quantity: 10,
      price: '14',
    });
    await waitFor(d.id, ['awaiting_conditions']);
    await accept(w, d.id, w.brand);
    await waitFor(d.id, ['eligible']);

    const pending = runCycle(w.tenantId);
    await expect.poll(() => slow.log.length, { timeout: 15_000 }).toBeGreaterThan(0);
    await new Promise((r) => setTimeout(r, 1_500));
    expect((await dealDetail(d.id, w.platform)).deal.status).toBe('settling');

    slow.settle(slow.log[0]?.result.externalRef as string);
    const body = JSON.stringify({
      id: `evt-${d.id}`,
      type: 'payment.confirmed',
      occurredAt: new Date().toISOString(),
      externalRef: slow.log[0]?.result.externalRef,
      raw: {},
    });
    await ingestRailEvent('slow', body, {});
    expect((await pending).status).toBe('settled');
    expect((await ingestRailEvent('slow', body, {})).duplicate).toBe(true);
  });

  it('a payment returned after confirmation lands back in the wallet', async () => {
    const w = await makeWorld(main, { net: net() });
    await w.fund(w.brand, 'EUR', eur('140'));
    const d = await w.deal({
      program: 'net',
      buyer: 'brand',
      seller: 'supplier',
      quantity: 10,
      price: '14',
    });
    await waitFor(d.id, ['awaiting_conditions']);
    await accept(w, d.id, w.brand);
    await waitFor(d.id, ['eligible']);
    await runCycle(w.tenantId);
    await waitFor(d.id, ['settled']);
    const payout = main.log.findLast((l) => l.req.member.id === w.supplier);
    const body = JSON.stringify({
      id: `ret-${d.id}`,
      type: 'payment.returned',
      occurredAt: new Date().toISOString(),
      externalRef: payout?.result.externalRef,
      raw: {},
    });
    await ingestRailEvent('mock', body, {});
    await expect.poll(() => w.available(w.supplier, 'EUR'), { timeout: 15_000 }).toBe(eur('140'));
  });

  it('credits only what the rail hands back when it keeps a fee', async () => {
    const w = await makeWorld(main, { net: net() });
    await w.fund(w.brand, 'EUR', eur('140'));
    const d = await w.deal({
      program: 'net',
      buyer: 'brand',
      seller: 'supplier',
      quantity: 10,
      price: '14',
    });
    await waitFor(d.id, ['awaiting_conditions']);
    await accept(w, d.id, w.brand);
    await waitFor(d.id, ['eligible']);
    await runCycle(w.tenantId);
    await waitFor(d.id, ['settled']);
    const payout = main.log.findLast((l) => l.req.member.id === w.supplier);
    const body = JSON.stringify({
      id: `ret-fee-${d.id}`,
      type: 'payment.returned',
      occurredAt: new Date().toISOString(),
      externalRef: payout?.result.externalRef,
      fee: { currency: 'EUR', amount: eur('5').toString() },
      raw: {},
    });
    await ingestRailEvent('mock', body, {});
    await expect.poll(() => w.available(w.supplier, 'EUR'), { timeout: 15_000 }).toBe(eur('135'));
  });
});

describe('programs', () => {
  it('forfeits margin to the buyer when a seller never performs', async () => {
    const w = await makeWorld(main, {
      t: {
        ...presetInputs.tradeAssurance,
        overrides: [],
        release: {
          ...presetInputs.tradeAssurance.release,
          timeout: '1s',
          onTimeout: 'refund',
          recheckEvery: '1s',
        },
      },
    });
    await w.fund(w.retailer, 'EUR', eur('1500'));
    await w.fund(w.brand, 'GBP', gbp('1000'));
    const d = await w.deal({
      program: 't',
      buyer: 'retailer',
      seller: 'brand',
      quantity: 100,
      price: '15',
    });
    await waitFor(d.id, ['refunded']);
    expect(await w.available(w.retailer, 'GBP')).toBeGreaterThan(0n);
  });

  it('verify-only checks the deal and moves no money', async () => {
    const w = await makeWorld(main, {
      v: { ...net(), settlement: { mode: 'verify_only', rail: 'mock' } },
    });
    const d = await w.deal({
      program: 'v',
      buyer: 'retailer',
      seller: 'supplier',
      quantity: 10,
      price: '15',
    });
    await waitFor(d.id, ['awaiting_conditions']);
    await accept(w, d.id, w.retailer);
    await waitFor(d.id, ['settled']);
    expect((await dealDetail(d.id, w.platform)).obligations).toHaveLength(0);
  });

  it('settles a deal the moment it is released under immediate timing', async () => {
    const w = await makeWorld(main, {
      now: net({ settlement: { rail: 'mock', netting: 'gross', timing: { mode: 'immediate' } } }),
    });
    await w.fund(w.brand, 'EUR', eur('140'));
    const d = await w.deal({
      program: 'now',
      buyer: 'brand',
      seller: 'supplier',
      quantity: 10,
      price: '14',
    });
    await waitFor(d.id, ['awaiting_conditions']);
    await accept(w, d.id, w.brand);
    await waitFor(d.id, ['settled']);
  });

  it('settles on a schedule without anyone asking', async () => {
    const w = await makeWorld(main, {
      s: net({ settlement: { rail: 'mock', timing: { mode: 'cycle', every: '1m' } } }),
    });
    await w.fund(w.brand, 'EUR', eur('140'));
    const d = await w.deal({
      program: 's',
      buyer: 'brand',
      seller: 'supplier',
      quantity: 10,
      price: '14',
    });
    await waitFor(d.id, ['awaiting_conditions']);
    await accept(w, d.id, w.brand);
    await waitFor(d.id, ['eligible']);
    expect(await settleDueGroups(w.tenantId, new Date())).toHaveLength(1);
    await waitFor(d.id, ['settled']);
    expect(await settleDueGroups(w.tenantId, new Date())).toHaveLength(0);
  });

  it('pays extra legs such as a platform fee, and caps them by program', async () => {
    const w = await makeWorld(main, {
      net: net({ dealShape: { maxLegsBps: 2_000 } }),
    });
    await w.fund(w.brand, 'EUR', eur('140'));
    const d = await w.deal({
      program: 'net',
      buyer: 'brand',
      seller: 'supplier',
      quantity: 10,
      price: '14',
      extra: { legs: [{ id: 'fee', payer: 'seller', payeeMemberId: w.retailer, bps: 1_000 }] },
    });
    await waitFor(d.id, ['awaiting_conditions']);
    await accept(w, d.id, w.brand);
    await waitFor(d.id, ['eligible']);
    await runCycle(w.tenantId);
    await waitFor(d.id, ['settled']);
    const payouts = main.log.filter(
      (l) => l.direction === 'payout' && [w.supplier, w.retailer].includes(l.req.member.id),
    );
    expect(payouts.map((p) => p.req.amount).sort()).toEqual([eur('126'), eur('14')].sort());
  });
});

describe('resilience of FX and locks', () => {
  const homeLocked = (railName: string): ProgramSpecInput =>
    net({ funding: { mode: 'prefunded', currency: 'home', fxBufferBps: 300 } }, railName);

  it('offers a choice when the rate outruns the buffer, and can defer the cycle', async () => {
    moving.rates['GBP/EUR'] = 1.15;
    const w = await makeWorld(moving, { p: homeLocked('moving') });
    await w.fund(w.brand, 'GBP', gbp('1000'));
    const d = await w.deal({
      program: 'p',
      buyer: 'brand',
      seller: 'supplier',
      quantity: 10,
      price: '100',
    });
    await waitFor(d.id, ['awaiting_conditions']);
    await accept(w, d.id, w.brand);
    await waitFor(d.id, ['eligible']);

    moving.rates['GBP/EUR'] = 0.9;
    brain.current = {
      name: 'planner',
      async decide() {
        return { action: { type: 'choose_plan', planId: 'defer_cycle' }, rationale: 'wait' };
      },
    };
    expect((await runCycle(w.tenantId)).status).toBe('deferred');
    await waitFor(d.id, ['eligible']);

    // Recovered enough to cover it: the next cycle converts and settles.
    moving.rates['GBP/EUR'] = 1.15;
    brain.current = undefined;
    expect((await runCycle(w.tenantId)).status).toBe('settled');
    await waitFor(d.id, ['settled']);
  });

  it('pulls a lock shortfall where the rail can debit the member', async () => {
    const w = await makeWorld(puller, { p: net({ funding: { mode: 'prefunded' } }, 'puller') });
    const d = await w.deal({
      program: 'p',
      buyer: 'retailer',
      seller: 'supplier',
      quantity: 10,
      price: '15',
    });
    await waitFor(d.id, ['awaiting_conditions']);
    expect(puller.log.filter((l) => l.direction === 'collect').map((l) => l.req.amount)).toEqual([
      eur('150'),
    ]);
  });

  it('halts and puts obligations back when a cycle breaks before commit', async () => {
    moving.rates['GBP/EUR'] = 1.15;
    const w = await makeWorld(moving, { p: homeLocked('moving') });
    await w.fund(w.brand, 'GBP', gbp('1000'));
    const d = await w.deal({
      program: 'p',
      buyer: 'brand',
      seller: 'supplier',
      quantity: 10,
      price: '100',
    });
    await waitFor(d.id, ['awaiting_conditions']);
    await accept(w, d.id, w.brand);
    await waitFor(d.id, ['eligible']);

    const saved = moving.rates['GBP/EUR'] as number;
    delete moving.rates['GBP/EUR'];
    expect((await runCycle(w.tenantId)).status).toBe('failed');
    moving.rates['GBP/EUR'] = saved;
    expect((await dealDetail(d.id, w.platform)).obligations[0]?.status).toBe('eligible');
    expect((await tenantStatus(w.tenantId)).settlementHaltedAt).not.toBeNull();
    expect((await runCycle(w.tenantId)).status).toBe('halted');
  });
});
