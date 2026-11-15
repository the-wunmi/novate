import { randomUUID } from 'node:crypto';
import { cycles, dealEvents } from '@novate/db';
import { MockRail } from '@novate/rails';
import { and, eq } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { deps } from '../src/deps.ts';
import {
  changeAgentMandate,
  contributeToDefaultFund,
  dealDetail,
  defaultFund,
  economics,
  economicsCsv,
  exposure,
  listDeals,
  memberAccount,
  memberAgents,
  memberSettlement,
  memberStatement,
  memberWithdrawals,
  requestWithdrawal,
  runCycle,
  settlementPreview,
  submitFact,
  updateTenantSettings,
  withdrawFromDefaultFund,
} from '../src/index.ts';
import {
  acceptedDeal,
  boot,
  escalatingBrain,
  eur,
  gbp,
  makeWorld,
  netProgram,
  personDecides,
  provisionEurMember,
  sent,
  shutdown,
  waitFor,
  waitForCase,
} from './harness.ts';

const rail = new MockRail();
const failing = new Set<string>();
const flaky = new MockRail({ name: 'flaky', failPayoutsFor: failing });
beforeAll(async () => {
  await boot(rail, [flaky]);
});
afterAll(() => shutdown());

describe('a member’s accounts and withdrawals', () => {
  it('shows how to pay in and where it is paid, masked, and withdraws there by default', async () => {
    const w = await makeWorld(rail, { net: netProgram() });
    const before = await memberAccount(w.tenantId, w.retailer);
    expect(before).toMatchObject({ depositAccounts: [], payoutAccount: null });
    expect(before.defaultWithdrawalRail).toBeNull();

    await provisionEurMember(w, w.retailer);
    const account = await memberAccount(w.tenantId, w.retailer);
    expect(account).toMatchObject({
      id: w.retailer,
      name: 'Dutch retailer',
      homeCurrency: 'EUR',
      status: 'active',
      payoutAccount: { rail: 'mock', currency: 'EUR', label: 'ABN AMRO ••••4300' },
      defaultWithdrawalRail: 'mock',
    });
    expect(JSON.stringify(account)).not.toContain('NL91ABNA0417164300');
    const [deposit] = account.depositAccounts;
    expect(deposit).toMatchObject({ rail: 'mock' });
    expect(deposit?.details).toMatchObject({
      currency: 'EUR',
      accountName: 'Dutch retailer',
      bankName: 'Mock Bank',
    });
    expect(deposit?.details?.accountNumber).toMatch(/^\d{8}$/);

    const view = await exposure(w.tenantId);
    expect(view.members.find((m) => m.memberId === w.retailer)?.provisioned).toBe(true);
    expect(view.members.find((m) => m.memberId === w.supplier)?.provisioned).toBe(false);

    await w.fund(w.retailer, 'EUR', eur('30'));
    const paidBefore = rail.log.length;
    const { id } = await sent(
      requestWithdrawal(w.tenantId, w.asMember(w.retailer), w.retailer, {
        currency: 'EUR',
        amount: eur('10'),
        idempotencyKey: randomUUID(),
      }),
    );
    await expect
      .poll(async () => (await memberWithdrawals(w.tenantId, w.retailer)).rows[0]?.status)
      .toBe('confirmed');
    expect(rail.log.slice(paidBefore).map((p) => [p.direction, p.req.amount])).toEqual([
      ['payout', eur('10')],
    ]);
    await requestWithdrawal(w.tenantId, w.asMember(w.retailer), w.retailer, {
      currency: 'EUR',
      amount: eur('5'),
      rail: 'mock',
      idempotencyKey: randomUUID(),
    });
    const { rows: withdrawals, next } = await memberWithdrawals(w.tenantId, w.retailer);
    expect(withdrawals.map((x) => x.amount)).toEqual([eur('5'), eur('10')]);
    expect(withdrawals[1]).toMatchObject({ id, currency: 'EUR', rail: 'mock' });
    expect(withdrawals[1]?.externalRef).toBeTruthy();
    expect(withdrawals[1]?.paidAt).toBeInstanceOf(Date);
    expect(next).toBeNull();
    const paged = await memberWithdrawals(w.tenantId, w.retailer, { limit: 1 });
    expect(paged.rows.map((x) => x.amount)).toEqual([eur('5')]);
    const rest = await memberWithdrawals(w.tenantId, w.retailer, {
      before: paged.next ?? undefined,
    });
    expect(rest.rows.map((x) => x.amount)).toEqual([eur('10')]);
    // Nobody else's withdrawals.
    expect((await memberWithdrawals(w.tenantId, w.supplier)).rows).toEqual([]);
  });

  it('refuses a withdrawal with no rail named when no payout account is on record', async () => {
    const w = await makeWorld(rail, { net: netProgram() });
    await w.fund(w.supplier, 'EUR', eur('20'));
    await expect(
      requestWithdrawal(w.tenantId, w.asMember(w.supplier), w.supplier, {
        currency: 'EUR',
        amount: eur('10'),
        idempotencyKey: randomUUID(),
      }),
    ).rejects.toThrow('No payout account');
    expect(await w.available(w.supplier, 'EUR')).toBe(eur('20'));
  });

  it('lists a failed withdrawal with its reason, back in the wallet', async () => {
    const w = await makeWorld(rail, { net: netProgram() });
    await provisionEurMember(w, w.retailer, 'flaky');
    await w.fund(w.retailer, 'EUR', eur('20'));
    failing.add(w.retailer);
    escalatingBrain();
    try {
      await requestWithdrawal(w.tenantId, w.asMember(w.retailer), w.retailer, {
        currency: 'EUR',
        amount: eur('20'),
        idempotencyKey: randomUUID(),
      });
      await expect
        .poll(
          async () => (await memberWithdrawals(w.tenantId, w.retailer)).rows[0]?.returnedToWallet,
          { timeout: 15_000 },
        )
        .toBe(true);
      const [first] = (await memberWithdrawals(w.tenantId, w.retailer)).rows;
      expect(first).toMatchObject({ rail: 'flaky', status: 'failed', paidAt: null });
      expect(first?.failureReason).toBeTruthy();
      expect(await w.available(w.retailer, 'EUR')).toBe(eur('20'));
    } finally {
      failing.delete(w.retailer);
    }
  });
});

describe('what a member sees of its deals and agents', () => {
  it('names both parties, says what settled, and lists only its own agents', async () => {
    const w = await makeWorld(rail, { net: netProgram() });
    await w.fund(w.retailer, 'EUR', eur('100'));
    const dealId = await acceptedDeal(w, 'retailer', 'supplier', '40');
    const [row] = (await listDeals(w.tenantId, { memberId: w.retailer })).rows;
    expect(row).toMatchObject({
      id: dealId,
      buyerName: 'Dutch retailer',
      sellerName: 'Portuguese supplier',
      settledAmount: null,
    });
    await runCycle(w.tenantId);
    await waitFor(dealId, ['settled']);
    const [settled] = (await listDeals(w.tenantId, { memberId: w.retailer })).rows;
    expect(settled).toMatchObject({ releaseAmount: eur('40'), settledAmount: eur('40') });
    const detail = await dealDetail(dealId, w.asMember(w.supplier));
    expect(detail.deal).toMatchObject({
      buyerName: 'Dutch retailer',
      sellerName: 'Portuguese supplier',
    });

    const agents = await memberAgents(w.tenantId, w.brand);
    expect(agents.map((a) => a.id).sort()).toEqual([w.brandBuyer, w.brandSeller].sort());
    expect(agents[0]).toHaveProperty('usage');
    const retailerAgents = await memberAgents(w.tenantId, w.retailer);
    expect(retailerAgents[0]?.usage.amounts).toEqual([
      { side: 'buy', currency: 'EUR', amount: eur('40') },
    ]);
  });
});

describe('settlement ahead and behind', () => {
  it('shows a member its waiting obligations by group, then the cycle that settled them', async () => {
    const program = netProgram({
      settlement: { rail: 'mock', timing: { mode: 'cycle', every: '1h' } },
    });
    const w = await makeWorld(rail, { net: program });
    await w.fund(w.brand, 'EUR', eur('100'));
    await w.fund(w.retailer, 'EUR', eur('50'));
    await acceptedDeal(w, 'brand', 'supplier', '50');
    await acceptedDeal(w, 'retailer', 'brand', '80');

    const now = new Date();
    const ahead = await memberSettlement(w.tenantId, w.brand, now);
    expect(ahead.cycles).toEqual([]);
    expect(ahead.upcoming).toHaveLength(1);
    expect(ahead.upcoming[0]).toMatchObject({
      settlementGroup: { rail: 'mock', netting: 'multilateral', timing: 'every:1h' },
      payable: [{ currency: 'EUR', amount: eur('50') }],
      receivable: [{ currency: 'EUR', amount: eur('80') }],
      net: [{ currency: 'EUR', amount: eur('30') }],
      deals: 2,
    });
    expect(ahead.upcoming[0]?.settlementGroup.program.key).toBe('net');
    // Never run: due at the next scheduler tick.
    expect(ahead.upcoming[0]?.nextRunAt?.getTime()).toBeLessThanOrEqual(now.getTime() + 60_000);

    const preview = await settlementPreview(w.tenantId, now);
    expect(preview.groups).toHaveLength(1);
    const [group] = preview.groups;
    expect(group).toMatchObject({ obligations: 2, deals: 2, notYetReleased: 0 });
    const position = (memberId: string) => group?.positions.find((p) => p.memberId === memberId);
    expect(position(w.brand)).toMatchObject({ payIn: 0n, receive: eur('30'), net: eur('30') });
    expect(position(w.retailer)).toMatchObject({
      payIn: eur('80'),
      walletAvailable: eur('50'),
      shortfall: eur('30'),
    });
    expect(position(w.supplier)).toMatchObject({ receive: eur('50') });
    expect(group?.currencies).toEqual([
      expect.objectContaining({
        currency: 'EUR',
        payIn: eur('80'),
        payInShortfall: eur('30'),
        railBalance: null,
        railShortfall: null,
      }),
    ]);
    // Brand is paid to its wallet, so only the supplier's payout needs the rail.
    expect(group?.currencies[0]?.payouts).toBe(eur('50'));

    await w.fund(w.retailer, 'EUR', eur('30'));
    const cycle = await runCycle(w.tenantId);
    expect(cycle.status).toBe('settled');
    const behind = await memberSettlement(w.tenantId, w.brand);
    expect(behind.upcoming).toEqual([]);
    expect(behind.cycles).toEqual([
      expect.objectContaining({
        id: cycle.cycleId,
        status: 'settled',
        net: [{ currency: 'EUR', amount: eur('30') }],
      }),
    ]);
    expect((await settlementPreview(w.tenantId)).groups).toEqual([]);
  });

  it('shows the default fund by member, from the ledger', async () => {
    const w = await makeWorld(rail, { net: netProgram() });
    await w.fund(w.retailer, 'EUR', eur('100'));
    await w.fund(w.supplier, 'EUR', eur('100'));
    const move = (memberId: string, amount: bigint) => ({
      memberId,
      currency: 'EUR',
      amount,
      idempotencyKey: randomUUID(),
      reason: 'Test move',
    });
    await contributeToDefaultFund(w.tenantId, w.person, move(w.retailer, eur('40')));
    await contributeToDefaultFund(w.tenantId, w.person, move(w.supplier, eur('10')));
    await withdrawFromDefaultFund(w.tenantId, w.person, move(w.retailer, eur('15')));
    const fund = await defaultFund(w.tenantId);
    expect(fund.balances).toEqual(
      expect.arrayContaining([
        { currency: 'EUR', amount: eur('35') },
        { currency: 'GBP', amount: 0n },
      ]),
    );
    expect(fund.contributions).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          memberId: w.retailer,
          name: 'Dutch retailer',
          contributed: eur('40'),
          withdrawn: eur('15'),
          drawn: 0n,
          balance: eur('25'),
        }),
        expect.objectContaining({ memberId: w.supplier, balance: eur('10') }),
      ]),
    );
    expect(fund.draws).toEqual([]);
    expect(fund.waterfall).toEqual([]);
  });
});

describe('FX a member can follow', () => {
  it('records the lock rate and its direction, and shows the rate on both legs of a conversion', async () => {
    const program = netProgram({
      funding: { mode: 'prefunded', timeout: '72h', currency: 'home', fxBufferBps: 300 },
    });
    const w = await makeWorld(rail, { net: program });
    await w.fund(w.brand, 'GBP', gbp('200'));
    const dealId = await acceptedDeal(w, 'brand', 'supplier', '100');
    const [locked] = await deps()
      .db.select()
      .from(dealEvents)
      .where(and(eq(dealEvents.dealId, dealId), eq(dealEvents.type, 'escrow_locked')));
    expect(locked?.payload).toMatchObject({
      currency: 'GBP',
      dealCurrency: 'EUR',
      marketRate: '1.15',
      bufferBps: 300,
    });
    // After the buffer the member paid more pounds per euro, so fewer euros per pound.
    const rate = Number(locked?.payload.rate);
    expect(rate).toBeLessThan(1.15);
    expect(rate).toBeGreaterThan(1.11);
    expect(locked?.payload.rateLabel).toBe(`1 GBP = ${locked?.payload.rate} EUR`);

    const cycle = await runCycle(w.tenantId);
    expect(cycle.status).toBe('settled');
    const statement = await memberStatement(w.tenantId, w.brand);
    const legs = statement.lines.filter((l) => l.kind === 'fx_conversion');
    expect(legs.map((l) => l.currency).sort()).toEqual(['EUR', 'GBP']);
    for (const leg of legs) {
      expect(leg).toMatchObject({
        cycleId: cycle.cycleId,
        rate: '1.15',
        rateLabel: '1 GBP = 1.15 EUR',
      });
      expect(leg.externalRef).toMatch(/^mockfx_/);
    }
    expect(legs.find((l) => l.currency === 'GBP')?.dealId).toBe(dealId);
  });
});

describe('claims with an amount', () => {
  it('refunds what the claim asked for and lists it with the window', async () => {
    escalatingBrain();
    const w = await makeWorld(rail, { net: netProgram() });
    await w.fund(w.retailer, 'EUR', eur('100'));
    const dealId = await acceptedDeal(w, 'retailer', 'supplier', '100');
    await runCycle(w.tenantId);
    await waitFor(dealId, ['settled']);
    await w.fund(w.supplier, 'EUR', eur('10'));

    const quiet = await dealDetail(dealId, w.asMember(w.retailer));
    expect(quiet).toMatchObject({ claims: [] });
    const until = (quiet as { claimUntil: Date | null }).claimUntil;
    expect(until?.getTime()).toBeGreaterThan(Date.now() + 6 * 86_400_000);

    // More than the seller was paid is refused before anything opens.
    await expect(
      submitFact(dealId, w.asMember(w.retailer), {
        kind: 'dispute',
        type: 'claim',
        data: { reason: 'broken', amount: String(eur('101')) },
      }),
    ).rejects.toThrow('more than the seller was paid');

    await submitFact(dealId, w.asMember(w.retailer), {
      kind: 'dispute',
      type: 'claim',
      data: { reason: 'four mugs broken', amount: String(eur('40')) },
    });
    const opened = await waitForCase(w.tenantId, { dealId: dealId });
    const open = await dealDetail(dealId, w.asMember(w.retailer));
    expect((open as { claims: unknown[] }).claims).toEqual([
      expect.objectContaining({ reason: 'four mugs broken', amount: eur('40'), status: 'open' }),
    ]);
    await personDecides(w, opened.id, {
      bindingHash: opened.bindingHash,
      action: { type: 'refund' },
      rationale: 'the photos show four broken',
    });
    await waitFor(dealId, ['refunded'], 30_000);
    expect(await w.available(w.retailer, 'EUR')).toBe(eur('40'));
    expect(await w.available(w.supplier, 'EUR')).toBe(0n);

    const after = await dealDetail(dealId, w.asMember(w.supplier));
    expect((after as { claims: unknown[] }).claims).toEqual([
      expect.objectContaining({
        amount: eur('40'),
        status: 'refunded',
        outcome: expect.objectContaining({ type: 'refunded', amount: eur('40') }),
      }),
    ]);
  }, 60_000);
});

describe('mandate limits per currency', () => {
  it('applies each currency’s own limit and refuses a currency it does not name', async () => {
    const w = await makeWorld(rail, { net: netProgram() });
    await changeAgentMandate(w.tenantId, w.platform, w.retailerAgent, {
      mandate: {
        roles: ['buy'],
        limits: { EUR: { maxPerDeal: eur('50') } },
      },
    });
    const over = await w.deal({
      program: 'net',
      buyer: 'retailer',
      seller: 'supplier',
      quantity: 1,
      price: '60',
    });
    expect((await waitFor(over.id, ['rejected'])).statusReason).toMatch(/per-deal limit .* EUR/);
    const within = await w.deal({
      program: 'net',
      buyer: 'retailer',
      seller: 'supplier',
      quantity: 1,
      price: '40',
    });
    await waitFor(within.id, ['awaiting_conditions']);
    const dollars = await w.deal({
      program: 'net',
      buyer: 'retailer',
      seller: 'supplier',
      quantity: 1,
      price: '10',
      extra: { currency: 'USD' },
    });
    expect((await waitFor(dollars.id, ['rejected'])).statusReason).toMatch(/may not deal in USD/);
  });
});

describe('economics', () => {
  it('splits fees collected from owed, and counts deals by program with their dates', async () => {
    const w = await makeWorld(rail, {
      net: netProgram({ fees: { sellerBps: 100, buyerBps: 100 } }),
    });
    await w.fund(w.retailer, 'EUR', eur('100'));
    await acceptedDeal(w, 'retailer', 'supplier', '100');
    await runCycle(w.tenantId);
    const report = await economics(w.tenantId);
    expect(report.feesCollected).toEqual([{ currency: 'EUR', amount: eur('1') }]);
    expect(report.feesOwed).toEqual([{ currency: 'EUR', amount: eur('1') }]);
    expect(report.railFeesPaid).toEqual([]);
    expect(report.cardFees).toEqual([]);
    expect(report.volume.byProgram).toEqual([
      expect.objectContaining({
        programKey: 'net',
        version: 1,
        rail: 'mock',
        label: 'Net settlement (Mock)',
        currency: 'EUR',
        amount: eur('100'),
        dealsOpened: 1,
        dealsSettled: 1,
      }),
    ]);
    expect(report.volume.byMember).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          memberId: w.retailer,
          deals: 1,
          fees: eur('1'),
          paid: eur('100'),
        }),
        expect.objectContaining({ memberId: w.supplier, deals: 1, fees: eur('1') }),
      ]),
    );
    expect(report.deals.dates).toMatchObject({ opened: 'deal created', settled: 'cycle closed' });
    const csv = await economicsCsv(w.tenantId, {
      from: new Date('2026-01-01'),
      to: new Date('2100-01-01'),
    });
    const [header, ...rows] = csv.body.trimEnd().split('\r\n');
    expect(header).toBe(
      'period_from,period_to,scope,id,label,currency,volume_minor,volume_major,paid_minor,paid_major,received_minor,received_major,deals_opened,deals_settled,fees_minor,fees_major',
    );
    expect(rows).toContain(
      `2026-01-01T00:00:00.000Z,2100-01-01T00:00:00.000Z,program,net@v1,Net settlement (Mock),EUR,10000,100.00,,,,,1,1,,`,
    );
    expect(rows).toContain(
      `2026-01-01T00:00:00.000Z,2100-01-01T00:00:00.000Z,fees_owed,,,EUR,,,,,,,,,100,1.00`,
    );
    expect(
      rows.some((r) => r.includes(`member,${w.retailer},,EUR,,,10000,100.00,0,0.00,,1,100,1.00`)),
    ).toBe(true);
  });

  it('puts a cycle in the month it closed in the tenant’s zone, not in UTC', async () => {
    const w = await makeWorld(rail, { net: netProgram() });
    await updateTenantSettings(w.tenantId, w.checker, { timeZone: 'Asia/Tokyo', reason: 'Desk' });
    await w.fund(w.retailer, 'EUR', eur('100'));
    await acceptedDeal(w, 'retailer', 'supplier', '100');
    await runCycle(w.tenantId);
    // 01:00 on 1 November in Tokyo, still 31 October in UTC.
    await deps()
      .db.update(cycles)
      .set({ closedAt: new Date('2026-10-31T16:00:00Z') })
      .where(and(eq(cycles.tenantId, w.tenantId), eq(cycles.status, 'settled')));
    const { byMonth } = await economics(w.tenantId, { to: new Date('2026-11-20T00:00:00Z') });
    expect(byMonth).toHaveLength(12);
    expect(byMonth.at(-1)).toMatchObject({
      month: '2026-11',
      settled: [{ currency: 'EUR', amount: eur('100') }],
      dealsSettled: 1,
    });
    expect(byMonth.at(-2)).toMatchObject({ month: '2026-10', settled: [], dealsSettled: 0 });
  });
});
