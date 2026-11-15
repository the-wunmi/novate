import { dealFacts } from '@novate/db';
import { Accounts } from '@novate/ledger';
import { presetInputs } from '@novate/policy';
import { MockRail } from '@novate/rails';
import { eq } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { deps } from '../src/deps.ts';
import {
  activityFeed,
  balances,
  changeAgentMandate,
  dealDetail,
  economics,
  exposure,
  memberCycle,
  memberStatement,
  memberStatementCsv,
  runCycle,
  submitFact,
} from '../src/index.ts';
import {
  acceptedDeal,
  boot,
  controlEventsOf,
  escalatingBrain,
  eur,
  makeWorld,
  netProgram,
  notified,
  personDecides,
  shutdown,
  type World,
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

const release = presetInputs.netSettlement.release;

const debtOf = async (w: World, memberId: string) =>
  (await balances(w.tenantId, memberId)).find((b) => b.kind === 'debt' && b.currency === 'EUR')
    ?.balance ?? 0n;

describe('member statement', () => {
  it('shows proceeds, amounts owed, netting and payouts, and reconciles', async () => {
    const w = await makeWorld(rail, { net: netProgram() });
    await w.fund(w.brand, 'EUR', eur('100'));
    await w.fund(w.retailer, 'EUR', eur('100'));
    const bought = await acceptedDeal(w, 'brand', 'supplier', '50');
    const sold = await acceptedDeal(w, 'retailer', 'brand', '80');

    // Before the cycle: what each will pay and receive.
    const before = await exposure(w.tenantId);
    const brandEur = before.members
      .find((m) => m.memberId === w.brand)
      ?.currencies.find((c) => c.currency === 'EUR');
    expect(brandEur?.openObligations).toEqual({
      payable: eur('50'),
      receivable: eur('80'),
      net: eur('30'),
    });
    expect(brandEur?.available).toBe(eur('100'));

    const cycle = await runCycle(w.tenantId);
    expect(cycle.status).toBe('settled');

    const brand = await memberStatement(w.tenantId, w.brand);
    const kinds = brand.lines.map((l) => [l.kind, l.amount, l.dealId]);
    expect(kinds).toEqual(
      expect.arrayContaining([
        ['deposit', eur('100'), null],
        ['amount_owed', -eur('50'), bought],
        ['deal_proceeds', eur('80'), sold],
        ['payout_to_wallet', 0n, null],
      ]),
    );
    expect(brand.lines.find((l) => l.kind === 'netting_offset')?.offset).toBe(eur('50'));
    expect(brand.lines.find((l) => l.kind === 'deal_proceeds')?.counterpartyId).toBe(w.retailer);
    // Newest first, and every running balance follows from the closing one.
    expect(brand.closingBalance).toEqual([
      { currency: 'EUR', amount: eur('130'), available: eur('130') },
    ]);
    expect(brand.lines[0]?.balance).toBe(eur('130'));
    const sum = brand.lines.reduce((acc, l) => acc + l.amount, 0n);
    expect(sum).toBe(eur('130'));

    const supplier = await memberStatement(w.tenantId, w.supplier);
    const payout = supplier.lines.find((l) => l.kind === 'payout');
    expect(payout).toMatchObject({ amount: -eur('50'), cycleId: cycle.cycleId });
    expect(payout?.externalRef).toBeTruthy();
    expect(payout?.valueDate).toBeInstanceOf(Date);
    expect(supplier.closingBalance[0]?.amount).toBe(0n);

    // A period after everything happened opens where the last one closed, with no lines.
    const later = await memberStatement(w.tenantId, w.brand, { from: new Date(Date.now() + 1000) });
    expect(later.lines).toEqual([]);
    expect(later.openingBalance).toEqual(brand.closingBalance);

    const csv = await memberStatementCsv(w.tenantId, w.brand);
    expect(csv.body.split('\r\n')[0]).toContain('at,kind,currency,amount_minor,amount_major');
    expect(csv.body).toContain(',amount_owed,EUR,-5000,-50.00,');

    // Only its own part of the cycle.
    const view = await memberCycle(w.tenantId, w.supplier, cycle.cycleId);
    expect(view.owed.map((o) => o.dealId)).toEqual([bought]);
    expect(view.position).toEqual([{ currency: 'EUR', owes: 0n, owed: eur('50'), net: eur('50') }]);
    expect(view.instructions.every((i) => i.direction === 'payout')).toBe(true);

    // A party's deal shows its history without the house's internals.
    const detail = await dealDetail(sold, w.asMember(w.retailer));
    const types = detail.events.map((e) => e.type);
    expect(types).toContain('settled');
    expect(types).not.toContain('policy_resolved');
    const settledEvent = detail.events.find((e) => e.type === 'settled');
    expect(settledEvent?.payload).toMatchObject({ amount: eur('80').toString(), currency: 'EUR' });
    const activity = (await activityFeed(w.tenantId)).rows;
    const released = activity.find(
      (i) => i.source === 'deal' && i.type === 'released' && i.dealId === sold,
    );
    expect(released).toMatchObject({ amount: eur('80'), currency: 'EUR' });
  });

  it('names the agent and member that filed a fact', async () => {
    const w = await makeWorld(rail, { net: netProgram() });
    const d = await w.deal({
      program: 'net',
      buyer: 'retailer',
      seller: 'supplier',
      quantity: 1,
      price: '5',
    });
    await waitFor(d.id, ['awaiting_conditions']);
    const asAgent = { ...w.asMember(w.retailer), kind: 'agent' as const, agentId: w.retailerAgent };
    const fact = await submitFact(d.id, asAgent, { kind: 'acceptance', type: 'buyer', data: {} });
    expect(fact.data.filedBy).toEqual({ agentId: w.retailerAgent, memberId: w.retailer });
    const detail = await dealDetail(d.id, w.platform);
    const added = detail.events.find((e) => e.type === 'fact_added');
    expect(added?.payload).toMatchObject({ agentId: w.retailerAgent, memberId: w.retailer });
  });

  it('tells a member when its payout is held in its wallet', async () => {
    escalatingBrain();
    const w = await makeWorld(flaky as never, {
      net: netProgram({ settlement: { rail: 'flaky' } }),
    });
    await w.fund(w.retailer, 'EUR', eur('20'));
    await acceptedDeal(w, 'retailer', 'supplier', '20');
    failing.add(w.supplier);
    await runCycle(w.tenantId);
    await expect
      .poll(() => notified.find((n) => n.type === 'payment_reduced' && n.memberId === w.supplier))
      .toMatchObject({ status: 'held', expected: eur('20').toString(), amount: '0' });
    expect(await w.available(w.supplier, 'EUR')).toBe(eur('20'));
  });
});

describe('platform fees', () => {
  it('takes each side’s fee into platform revenue, and records what the wallet could not pay', async () => {
    const w = await makeWorld(rail, {
      net: netProgram({ fees: { sellerBps: 100, buyerBps: 100 } }),
    });
    // Exactly the price: the buyer's fee finds nothing left and becomes a debt.
    await w.fund(w.retailer, 'EUR', eur('100'));
    const dealId = await acceptedDeal(w, 'retailer', 'supplier', '100');
    const paidBefore = rail.log.length;
    expect((await runCycle(w.tenantId)).status).toBe('settled');
    await waitFor(dealId, ['settled']);

    const payouts = rail.log.slice(paidBefore).filter((p) => p.req.member.id === w.supplier);
    expect(payouts.map((p) => p.req.amount)).toEqual([eur('99')]);
    const { db, ledger } = deps();
    // With no `platformShareBps`, all of each fee is the platform's.
    expect(await ledger.balance(db, w.tenantId, Accounts.platformFeeRevenue('EUR'))).toBe(eur('2'));
    expect(await ledger.balance(db, w.tenantId, Accounts.houseFeeRevenue('EUR'))).toBe(0n);
    expect(await debtOf(w, w.retailer)).toBe(-eur('1'));

    const report = await economics(w.tenantId);
    expect(report.feesCollected).toEqual([{ currency: 'EUR', amount: eur('1') }]);
    expect(report.feesOwed).toEqual([{ currency: 'EUR', amount: eur('1') }]);
    expect(report.volume.byCurrency).toEqual([
      { currency: 'EUR', amount: eur('100'), obligations: 1 },
    ]);
    expect(report.volume.byProgram).toEqual([
      expect.objectContaining({
        programKey: 'net',
        currency: 'EUR',
        amount: eur('100'),
        dealsSettled: 1,
      }),
    ]);
    expect(report.deals.settled).toBe(1);
    const statement = await memberStatement(w.tenantId, w.supplier);
    expect(statement.lines.find((l) => l.kind === 'fee')?.amount).toBe(-eur('1'));
  });
});

describe('claims after settlement', () => {
  it('opens a case, and a refund comes from the seller’s wallet, then as its debt', async () => {
    escalatingBrain();
    const w = await makeWorld(rail, { net: netProgram() });
    await w.fund(w.retailer, 'EUR', eur('100'));
    const dealId = await acceptedDeal(w, 'retailer', 'supplier', '100');
    await runCycle(w.tenantId);
    await waitFor(dealId, ['settled']);
    await w.fund(w.supplier, 'EUR', eur('30'));

    await submitFact(dealId, w.asMember(w.retailer), {
      kind: 'dispute',
      type: 'claim',
      data: { reason: 'half the mugs arrived broken' },
    });
    const opened = await waitForCase(w.tenantId, { dealId: dealId });
    expect(opened.kind).toBe('exception');
    await personDecides(w, opened.id, {
      bindingHash: opened.bindingHash,
      action: { type: 'refund' },
      rationale: 'the inspector confirmed the breakage',
    });
    await waitFor(dealId, ['refunded'], 30_000);

    expect(await w.available(w.retailer, 'EUR')).toBe(eur('100'));
    expect(await w.available(w.supplier, 'EUR')).toBe(0n);
    expect(await debtOf(w, w.supplier)).toBe(-eur('70'));
    const detail = await dealDetail(dealId, w.asMember(w.retailer));
    expect(detail.cases).toEqual([
      expect.objectContaining({
        kind: 'exception',
        decision: expect.objectContaining({
          action: { type: 'refund' },
          deciderType: 'person',
        }),
      }),
    ]);
    expect(detail.cases[0]).not.toHaveProperty('bindingHash');
  }, 60_000);

  it('refuses a claim once the window has passed', async () => {
    const w = await makeWorld(rail, {
      net: netProgram({ release: { ...release, claimWindow: '1s' } }),
    });
    await w.fund(w.retailer, 'EUR', eur('10'));
    const dealId = await acceptedDeal(w, 'retailer', 'supplier', '10');
    await runCycle(w.tenantId);
    await waitFor(dealId, ['settled']);
    await new Promise((r) => setTimeout(r, 1_100));
    await expect(
      submitFact(dealId, w.asMember(w.retailer), { kind: 'dispute', type: 'claim', data: {} }),
    ).rejects.toThrow('claim window');
    const facts = await deps().db.select().from(dealFacts).where(eq(dealFacts.dealId, dealId));
    expect(facts.some((f) => f.kind === 'dispute')).toBe(false);
  });
});

describe('mandates', () => {
  it('replaces an agent’s mandate and records the change', async () => {
    const w = await makeWorld(rail, { net: netProgram() });
    const mandate = { roles: ['buy' as const], limits: { EUR: { maxPerDeal: eur('500') } } };
    const agent = await changeAgentMandate(w.tenantId, w.platform, w.retailerAgent, {
      mandate,
      reason: 'tighter limits',
    });
    expect(agent.mandate).toMatchObject({ limits: { EUR: { maxPerDeal: eur('500').toString() } } });
    const [event] = await controlEventsOf(w.tenantId, 'agent_mandate_changed');
    expect(event?.reason).toBe('tighter limits');
    expect(event?.payload).toMatchObject({
      agentId: w.retailerAgent,
      from: { roles: ['buy'], limits: { EUR: {}, USD: {} } },
      to: { limits: { EUR: { maxPerDeal: eur('500').toString() } } },
    });
    await expect(
      changeAgentMandate(w.tenantId, w.platform, w.retailerAgent, {
        mandate: { roles: [] } as never,
      }),
    ).rejects.toThrow();
  });
});
