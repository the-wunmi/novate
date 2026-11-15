import { randomUUID } from 'node:crypto';
import { MockRail } from '@novate/rails';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  contributeToDefaultFund,
  cycleDetail,
  defaultFund,
  exposure,
  ingestRailEvent,
  memberStatement,
  railBooks,
  recordRailOpening,
  runCycle,
  settlementSummary,
} from '../src/index.ts';
import {
  acceptedDeal,
  boot,
  eur,
  gbp,
  makeWorld,
  netProgram,
  owning,
  reconcile,
  shutdown,
  waitFor,
} from './harness.ts';

const rail = new MockRail();
// Charges the sell side of a conversion rounded down, where members sell at amounts rounded up.
const rounding = new MockRail({ name: 'rounding', roundSellDown: true });
const slow = new MockRail({ name: 'slow', async: true, holdUntilSettled: true });
beforeAll(async () => {
  await boot(rail, [rounding, slow]);
});
afterAll(() => shutdown());

const prefunded = (railName = 'mock') =>
  netProgram({
    settlement: { rail: railName },
    funding: { mode: 'prefunded', timeout: '72h', currency: 'home', fxBufferBps: 300 },
  });

describe('the house’s own exposure', () => {
  it('totals what members owe that nothing it holds secures, and names the largest', async () => {
    const w = await makeWorld(rail, { net: netProgram(), pre: prefunded() });
    await w.fund(w.retailer, 'EUR', eur('300'));
    await w.fund(w.brand, 'GBP', gbp('200'));
    // Nothing is locked up front under net settlement; the brand's deal is locked in pounds.
    await acceptedDeal(w, 'retailer', 'supplier', '100', 'net');
    await acceptedDeal(w, 'brand', 'supplier', '50', 'pre');
    await contributeToDefaultFund(w.tenantId, w.person, {
      memberId: w.retailer,
      currency: 'EUR',
      amount: eur('20'),
      idempotencyKey: randomUUID(),
      reason: 'Required contribution',
    });

    const { risk } = await exposure(w.tenantId);
    expect(risk).toEqual([
      {
        currency: 'EUR',
        payable: eur('150'),
        unsecured: eur('100'),
        largest: { memberId: w.retailer, name: 'Dutch retailer', amount: eur('100') },
        defaultFund: eur('20'),
        marginCalls: { count: 0, amount: 0n },
        cardsFronted: 0n,
      },
    ]);
    const [member] = (await exposure(w.tenantId)).members.filter((m) => m.memberId === w.brand);
    expect(member).toMatchObject({ depositAccounts: [], payoutAccount: null });
  });

  it('puts nothing at risk for a deal still waiting for its buyer’s money', async () => {
    const w = await makeWorld(rail, { pre: prefunded() });
    const d = await w.deal({
      program: 'pre',
      buyer: 'retailer',
      seller: 'supplier',
      quantity: 1,
      price: '80',
    });
    await waitFor(d.id, ['awaiting_funding']);

    const { risk } = await exposure(w.tenantId);
    expect(risk).toEqual([
      expect.objectContaining({
        currency: 'EUR',
        payable: eur('80'),
        unsecured: 0n,
        largest: null,
      }),
    ]);
  });

  it('counts a committed cycle as secured while its payout waits on the rail', async () => {
    const w = await makeWorld(slow, {
      net: netProgram({ settlement: { rail: 'slow', confirmWithin: '1h' } }),
    });
    await w.fund(w.brand, 'EUR', eur('140'));
    const dealId = await acceptedDeal(w, 'brand', 'supplier', '140');
    expect((await exposure(w.tenantId)).risk).toEqual([
      expect.objectContaining({ currency: 'EUR', unsecured: eur('140') }),
    ]);

    const pending = runCycle(w.tenantId);
    await expect.poll(() => slow.log.length, { timeout: 15_000 }).toBeGreaterThan(0);
    expect((await exposure(w.tenantId)).risk).toEqual([
      expect.objectContaining({ currency: 'EUR', payable: eur('140'), unsecured: 0n }),
    ]);

    const externalRef = slow.log[0]?.result.externalRef as string;
    slow.settle(externalRef);
    await ingestRailEvent(
      'slow',
      JSON.stringify({
        id: `evt-${dealId}`,
        type: 'payment.confirmed',
        occurredAt: new Date().toISOString(),
        externalRef,
        raw: {},
      }),
      {},
    );
    expect((await pending).status).toBe('settled');
  });

  it('says which currency an empty default fund is in', async () => {
    const w = await makeWorld(rail, { net: netProgram() });
    const fund = await defaultFund(w.tenantId);
    expect(fund.balances).toEqual(
      expect.arrayContaining([
        { currency: 'EUR', amount: 0n },
        { currency: 'GBP', amount: 0n },
      ]),
    );
    expect(fund.waterfall).toEqual([]);
  });
});

describe('FX rounding', () => {
  it('shows what members paid beside what the rail charged, and the rounding the house kept', async () => {
    const w = await makeWorld(rounding, { net: prefunded('rounding') });
    await recordRailOpening(w.tenantId, 'rounding');
    await w.fund(w.brand, 'GBP', gbp('200'));
    const dealId = await acceptedDeal(w, 'brand', 'supplier', '100');
    const cycle = await runCycle(w.tenantId);
    expect(cycle.status).toBe('settled');
    await waitFor(dealId, ['settled']);

    // 100 EUR at 1.15 is 86.9565 GBP: the member sells 86.96, the rail charges 86.95.
    const detail = await cycleDetail(w.tenantId, cycle.cycleId);
    expect(detail.cycle.converted).toEqual([
      expect.objectContaining({
        sellCurrency: 'GBP',
        sellAmount: gbp('86.95'),
        buyAmount: eur('100'),
        rateLabel: '1 GBP = 1.15 EUR',
      }),
    ]);
    expect(detail.exchanges).toEqual([
      {
        memberId: w.brand,
        sellCurrency: 'GBP',
        sold: gbp('86.96'),
        buyCurrency: 'EUR',
        bought: eur('100'),
      },
    ]);
    expect(detail.rounding).toEqual([{ currency: 'GBP', amount: gbp('0.01') }]);
    expect(detail.openFx).toEqual([]);

    // Netting is measured in the obligations' own currency, whatever was converted to fund them.
    expect((await settlementSummary(w.tenantId)).netting).toEqual([
      { currency: 'EUR', cycles: 1, owed: eur('100'), paid: eur('100'), netted: 0n },
    ]);

    // The member's statement says what it paid, the same as the cycle's exchange.
    const statement = await memberStatement(w.tenantId, w.brand);
    const sold = statement.lines.find((l) => l.kind === 'fx_conversion' && l.currency === 'GBP');
    expect(sold?.amount).toBe(-gbp('86.96'));

    // The books still agree with the rail, and name the penny the house kept and where it came from.
    expect(await reconcile(w.tenantId, 'rounding')).toMatchObject({ status: 'clean' });
    const books = await owning(w.tenantId, 'rounding', () => railBooks(w.tenantId));
    const pounds = books
      .find((b) => b.rail === 'rounding')
      ?.positions.find((p) => p.currency === 'GBP');
    expect(pounds?.houseOwn).toBe(gbp('0.01'));
    expect(pounds?.houseOwnParts).toEqual([
      {
        kind: 'fx_rounding',
        amount: gbp('0.01'),
        refs: [{ type: 'cycle', id: cycle.cycleId, amount: gbp('0.01') }],
        more: 0,
      },
    ]);
  });
});

describe('settlement over a period', () => {
  it('counts cycles and what netting offset, per currency, from the server', async () => {
    const w = await makeWorld(rail, { net: netProgram() });
    const start = new Date();
    await w.fund(w.retailer, 'EUR', eur('100'));
    // The brand owes the supplier 60 and is owed 100 by the retailer: 60 of 160 never moves.
    const one = await acceptedDeal(w, 'retailer', 'brand', '100');
    const two = await acceptedDeal(w, 'brand', 'supplier', '60');
    expect((await runCycle(w.tenantId)).status).toBe('settled');
    await waitFor(one, ['settled']);
    await waitFor(two, ['settled']);

    expect(await settlementSummary(w.tenantId, { from: start.toISOString() })).toMatchObject({
      cycles: { settled: 1 },
      netting: [
        { currency: 'EUR', cycles: 1, owed: eur('160'), paid: eur('100'), netted: eur('60') },
      ],
    });
    const later = new Date(Date.now() + 60_000).toISOString();
    expect(await settlementSummary(w.tenantId, { from: later })).toMatchObject({
      cycles: {},
      netting: [],
    });
  });
});
