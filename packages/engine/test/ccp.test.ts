import { randomUUID } from 'node:crypto';
import { DBOS } from '@dbos-inc/dbos-sdk';
import { marginCalls } from '@novate/db';
import { type ProgramSpecInput, presetInputs } from '@novate/policy';
import { MockRail } from '@novate/rails';
import { eq } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { deps } from '../src/deps.ts';
import {
  assignDeposit,
  balances,
  contributeToDefaultFund,
  dealDetail,
  ingestRailEvent,
  type launchEngine,
  memberMargin,
  monitorWorkflow,
  runCycle,
  runReconciliation,
  submitFact,
  unattributedDepositsOf,
} from '../src/index.ts';
import { boot, brain, eur, gbp, makeWorld, notified, shutdown, waitFor } from './harness.ts';

const rail = new MockRail({ pull: false });
const orphans = new MockRail({ name: 'orphans' });
let engine: Awaited<ReturnType<typeof launchEngine>>;
beforeAll(async () => {
  engine = await boot(rail, [orphans]);
});
afterAll(() => shutdown());

const ccp: ProgramSpecInput = {
  ...presetInputs.centralCounterparty,
  signals: ['history'],
  settlement: { rail: 'mock', netting: 'multilateral', fundingWindow: '1s' },
};

type World = Awaited<ReturnType<typeof makeWorld>>;

const monitor = async (tenantId: string) =>
  (await DBOS.startWorkflow(monitorWorkflow)(tenantId)).getResult();
const accept = (w: World, dealId: string, memberId: string) =>
  submitFact(dealId, w.asMember(memberId), { kind: 'acceptance', type: 'buyer', data: {} });
const margin = async (w: World, memberId: string) =>
  (await memberMargin(w.tenantId, memberId)).posted[0]?.amount ?? 0n;
const buy = (w: World, quantity: number, price: string) =>
  w.deal({ program: 'ccp', buyer: 'brand', seller: 'supplier', quantity, price });
const rate = (value: number) => {
  rail.rates['EUR/GBP'] = value;
};
const makeOverdue = (callId: string | undefined) =>
  engine.db
    .update(marginCalls)
    .set({ dueAt: new Date(Date.now() - 1_000) })
    .where(eq(marginCalls.id, callId as string));

/** Commit a member's free money elsewhere, so a later call cannot be met from its wallet. */
async function tieUpWallet(w: World, memberId: string, currency: string) {
  await contributeToDefaultFund(w.tenantId, {
    memberId,
    currency,
    amount: await w.available(memberId, currency),
    idempotencyKey: randomUUID(),
  });
}

const answering = (type: string) => {
  brain.current = {
    name: 'stub',
    decide: async () => ({ action: { type }, rationale: `chose ${type}` }),
  };
};

describe('central counterparty', () => {
  it('collects margin as a position opens and gives it back once it settles', async () => {
    rate(0.87);
    const w = await makeWorld(rail, { ccp });
    await w.fund(w.brand, 'GBP', gbp('2000'));
    const d = await buy(w, 100, '100');
    await waitFor(d.id, ['awaiting_conditions']);

    const posted = await margin(w, w.brand);
    // 5% of the GBP value of a EUR 10,000 payable, plus a stress add-on for the currency.
    expect(posted).toBeGreaterThan(gbp('435'));
    expect(posted).toBeLessThan(gbp('1000'));
    expect(await w.available(w.brand, 'GBP')).toBe(gbp('2000') - posted);

    await accept(w, d.id, w.brand);
    await waitFor(d.id, ['eligible']);
    await w.fund(w.brand, 'EUR', eur('10000'));
    await runCycle(w.tenantId);
    await waitFor(d.id, ['settled']);

    await monitor(w.tenantId);
    expect(await margin(w, w.brand)).toBe(0n);
    expect(await w.available(w.brand, 'GBP')).toBe(gbp('2000'));
  });

  it('takes more from the wallet when the rate moves against a position', async () => {
    rate(0.87);
    const w = await makeWorld(rail, { ccp });
    await w.fund(w.brand, 'GBP', gbp('3000'));
    const d = await buy(w, 100, '100');
    await waitFor(d.id, ['awaiting_conditions']);
    const before = await margin(w, w.brand);

    rate(0.97);
    const summary = await monitor(w.tenantId);
    // 10,000 EUR now costs 1,000 GBP more than when the deal opened.
    expect((await margin(w, w.brand)) - before).toBeGreaterThan(gbp('1000'));
    expect(summary.portfolio.calls).toBe(0);
  });

  it('refuses a position a member cannot cover, and leaves no call behind', async () => {
    rate(0.87);
    const w = await makeWorld(rail, { ccp });
    await w.fund(w.brand, 'GBP', gbp('10'));
    const d = await buy(w, 100, '100');
    await waitFor(d.id, ['cancelled']);
    // Cleared by the deal's last step, just after it is marked cancelled.
    await expect
      .poll(async () => (await memberMargin(w.tenantId, w.brand)).openCall, { timeout: 10_000 })
      .toBeNull();
    expect(await margin(w, w.brand)).toBe(0n);
    expect(await w.available(w.brand, 'GBP')).toBe(gbp('10'));
  });

  it('runs a default through collateral and the fund, and still pays the creditor', async () => {
    rate(0.87);
    const w = await makeWorld(rail, { ccp });
    await w.fund(w.brand, 'GBP', gbp('700'));
    await w.fund(w.retailer, 'EUR', eur('5000'));
    await contributeToDefaultFund(w.tenantId, {
      memberId: w.retailer,
      currency: 'EUR',
      amount: eur('2000'),
      idempotencyKey: randomUUID(),
    });
    const d = await buy(w, 10, '100');
    await waitFor(d.id, ['awaiting_conditions']);
    const posted = await margin(w, w.brand);
    expect(posted).toBeGreaterThan(0n);

    // The rate spikes and the brand has nothing free to meet the call with.
    await tieUpWallet(w, w.brand, 'GBP');
    rate(1.4);
    expect((await monitor(w.tenantId)).portfolio.calls).toBe(1);
    const { openCall } = await memberMargin(w.tenantId, w.brand);
    expect(openCall?.amount).toBeGreaterThan(0n);

    answering('declare_default');
    await makeOverdue(openCall?.id);
    expect((await monitor(w.tenantId)).portfolio.defaults).toBe(1);
    await expect.poll(() => notified.some((n) => n.type === 'member_defaulted')).toBe(true);

    // Close-only: a new position is refused, but the open one still has to settle.
    const refused = await buy(w, 1, '1');
    await waitFor(refused.id, ['rejected']);

    await accept(w, d.id, w.brand);
    await waitFor(d.id, ['eligible']);
    rate(0.87);
    const cycle = await runCycle(w.tenantId);
    expect(cycle.status).toBe('settled');
    expect(cycle.failures.map((f) => f.memberId)).toEqual([w.brand]);
    await waitFor(d.id, ['settled']);
    expect(rail.log.some((p) => p.direction === 'payout' && p.req.amount === eur('1000'))).toBe(
      true,
    );

    // Collateral went first, sold for euros. The fund made up the rest, and the house lost nothing.
    expect(await margin(w, w.brand)).toBe(0n);
    expect(rail.conversions.at(-1)).toMatchObject({ sellCurrency: 'GBP', buyCurrency: 'EUR' });
    const fund = (await balances(w.tenantId, w.retailer)).find((b) =>
      b.code.endsWith(':default_fund'),
    )?.balance;
    expect(fund).toBeLessThan(eur('2000'));
    expect(fund).toBeGreaterThan(eur('1000'));
    const house = await deps().ledger.balances(deps().db as never, w.tenantId, 'house:EUR:');
    expect(house.find((a) => a.code.endsWith(':default_loss'))?.balance ?? 0n).toBe(0n);
    expect((await dealDetail(d.id, w.platform)).deal.status).toBe('settled');
  });

  it('extends a call only as many times as the program allows', async () => {
    rate(0.87);
    const w = await makeWorld(rail, { ccp });
    await w.fund(w.brand, 'GBP', gbp('700'));
    const d = await buy(w, 10, '100');
    await waitFor(d.id, ['awaiting_conditions']);
    await tieUpWallet(w, w.brand, 'GBP');

    const refusals: string[][] = [];
    brain.current = {
      name: 'always-extends',
      async decide(_view, prior) {
        refusals.push(prior);
        return { action: { type: 'extend_call' }, rationale: 'one more go' };
      },
    };
    rate(1.4);
    await monitor(w.tenantId);
    await makeOverdue((await memberMargin(w.tenantId, w.brand)).openCall?.id);
    expect((await monitor(w.tenantId)).portfolio.extended).toBe(1);
    const extended = (await memberMargin(w.tenantId, w.brand)).openCall;
    expect(extended?.dueAt.getTime()).toBeGreaterThan(Date.now());

    // Out of extensions: code refuses the model's answer and the member defaults.
    await makeOverdue(extended?.id);
    expect((await monitor(w.tenantId)).portfolio.defaults).toBe(1);
    expect(refusals.flat().join()).toContain('no attempts are left');
  });

  it('leaves a member alone when its currency cannot be priced', async () => {
    rate(0.87);
    const w = await makeWorld(rail, { ccp });
    await w.fund(w.brand, 'GBP', gbp('700'));
    const d = await buy(w, 10, '100');
    await waitFor(d.id, ['awaiting_conditions']);
    await tieUpWallet(w, w.brand, 'GBP');
    const posted = await margin(w, w.brand);

    delete rail.rates['EUR/GBP'];
    try {
      const summary = await monitor(w.tenantId);
      expect(summary.portfolio.calls).toBe(0);
      expect(await margin(w, w.brand)).toBe(posted);
    } finally {
      rate(0.87);
    }
  });
});

describe('program templates', () => {
  it('settles a real-time deal alone, as soon as the buyer accepts', async () => {
    const w = await makeWorld(rail, {
      rt: { ...presetInputs.realtimeAgentClearing, checks: [] },
    });
    await w.fund(w.retailer, 'EUR', eur('50'));
    const d = await w.deal({
      program: 'rt',
      buyer: 'retailer',
      seller: 'supplier',
      quantity: 5,
      price: '10',
    });
    await waitFor(d.id, ['awaiting_conditions']);
    expect(await w.available(w.retailer, 'EUR')).toBe(0n);
    await accept(w, d.id, w.retailer);
    await waitFor(d.id, ['settled']);
  });

  it('records a verification and moves no money', async () => {
    const w = await makeWorld(rail, { v: presetInputs.verificationOnly });
    const d = await w.deal({
      program: 'v',
      buyer: 'retailer',
      seller: 'supplier',
      quantity: 5,
      price: '10',
    });
    await waitFor(d.id, ['awaiting_conditions']);
    await w.pass(d.id, { amount: eur('50'), quantity: 5 });
    await waitFor(d.id, ['settled']);
    expect((await dealDetail(d.id, w.platform)).obligations).toHaveLength(0);
    expect(await w.available(w.retailer, 'EUR')).toBe(0n);
  });
});

describe('deposits nobody can be matched to', () => {
  const webhook = (type: string, externalRef: string) =>
    ingestRailEvent(
      'orphans',
      JSON.stringify({
        id: randomUUID(),
        type,
        occurredAt: new Date().toISOString(),
        externalRef,
        depositAccountRef: 'ga-nobody',
        currency: 'EUR',
        amount: String(eur('300')),
        raw: {},
      }),
      {},
    );
  const held = async (tenantId: string) => (await unattributedDepositsOf(tenantId))[0];

  it('waits in suspense, keeps reconciliation clean, and can be assigned once', async () => {
    const w = await makeWorld(rail, { ccp });
    const externalRef = `dep-${randomUUID()}`;
    orphans.simulateDeposit('EUR', eur('300'), externalRef);
    deps().railOwners.orphans = w.tenantId;
    try {
      await webhook('deposit.settled', externalRef);
      await expect.poll(() => held(w.tenantId), { timeout: 15_000 }).toBeDefined();
      const row = await held(w.tenantId);
      expect(row?.amount).toBe(eur('300'));
      expect((await runReconciliation(w.tenantId, 'orphans')).status).toBe('clean');

      const before = await w.available(w.retailer, 'EUR');
      await assignDeposit(w.tenantId, row?.id as string, { memberId: w.retailer });
      expect((await w.available(w.retailer, 'EUR')) - before).toBe(eur('300'));
      await expect(
        assignDeposit(w.tenantId, row?.id as string, { memberId: w.retailer }),
      ).rejects.toThrow('already assigned');
      expect((await runReconciliation(w.tenantId, 'orphans')).status).toBe('clean');
    } finally {
      delete deps().railOwners.orphans;
    }
  });

  it('gives money back to the rail if a deposit in suspense is recalled', async () => {
    const w = await makeWorld(rail, { ccp });
    const externalRef = `dep-${randomUUID()}`;
    deps().railOwners.orphans = w.tenantId;
    try {
      await webhook('deposit.settled', externalRef);
      await expect.poll(() => held(w.tenantId), { timeout: 15_000 }).toBeDefined();
      await webhook('deposit.reversed', externalRef);
      await expect.poll(() => held(w.tenantId), { timeout: 15_000 }).toBeUndefined();
      const house = await deps().ledger.balances(deps().db as never, w.tenantId, 'house:');
      expect(house.find((a) => a.code === 'house:EUR:suspense')?.balance ?? 0n).toBe(0n);
    } finally {
      delete deps().railOwners.orphans;
    }
  });
});
