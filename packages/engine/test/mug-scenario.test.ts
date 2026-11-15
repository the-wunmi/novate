import { applyBps, fxSellAmount } from '@novate/core';
import { dealEvents, dealFacts } from '@novate/db';
import { MockRail } from '@novate/rails';
import { and, eq } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { deps } from '../src/deps.ts';
import { decideCase, runCycle, submitFact } from '../src/index.ts';
import {
  boot,
  brain,
  eur,
  frozenBigOrder,
  gbp,
  makeWorld,
  personDecides,
  shutdown,
  waitFor,
  waitForCase,
} from './harness.ts';

const rail = new MockRail();
const RATE = 115_000_000n; // 1.15 EUR per GBP

beforeAll(() => boot(rail), 60_000);
afterAll(() => shutdown());

/** What a lock of `eurAmount` costs in GBP, buffer included. */
const gbpLock = (eurAmount: bigint) =>
  applyBps(fxSellAmount(eurAmount, RATE, 'GBP', 'EUR'), 10_300);

describe('mug scenario', () => {
  it('clears both deals, converting only the net €3,880', async () => {
    brain.current = undefined;
    const w = await makeWorld(rail, undefined, { EUR: { monthlyLimit: eur('20000') } });
    await w.fund(w.brand, 'GBP', gbp('15000'));
    await w.fund(w.retailer, 'EUR', eur('9000'));
    await w.fund(w.supplier, 'EUR', eur('1000'));

    const buy = await w.deal({ buyer: 'brand', seller: 'supplier', quantity: 1_000, price: '14' });
    const sell = await w.deal({ buyer: 'retailer', seller: 'brand', quantity: 600, price: '15' });
    await waitFor(buy.id, ['awaiting_conditions']);
    await waitFor(sell.id, ['awaiting_conditions']);

    // The brand locks in its own currency, with a buffer against the rate moving.
    const locked = gbpLock(eur('14000'));
    const margin = gbpLock(eur('450'));
    expect(await w.available(w.brand, 'GBP')).toBe(gbp('15000') - locked - margin);
    expect(await w.available(w.supplier, 'EUR')).toBe(eur('300'));

    // Shipped a day late, inside tolerance. 8% chipped, so the supplier is paid for 92%.
    await w.pass(buy.id, {
      amount: eur('14000'),
      quantity: 1_000,
      shipped: '2026-11-03',
      pass: { inspected: 1_000, passed: 920 },
    });
    const released = await waitFor(buy.id, ['eligible']);
    expect(released.releaseAmount).toBe(eur('12880'));
    await w.pass(sell.id, { amount: eur('9000'), quantity: 600 });
    await waitFor(sell.id, ['eligible']);

    const cycle = await runCycle(w.tenantId);
    expect(cycle.status).toBe('settled');
    await waitFor(buy.id, ['settled']);
    await waitFor(sell.id, ['settled']);

    // One conversion, for the net, against €21,880 without netting.
    expect(rail.conversions.map((c) => c.buyAmount)).toEqual([eur('3880')]);
    expect(cycle.fx?.boughtGross.EUR).toBe(eur('21880'));

    const sold = fxSellAmount(eur('3880'), RATE, 'GBP', 'EUR');
    expect(await w.available(w.brand, 'GBP')).toBe(gbp('15000') - sold);
    expect(await w.available(w.supplier, 'EUR')).toBe(eur('1000'));
    expect(await w.available(w.retailer, 'EUR')).toBe(0n);
    const payouts = rail.log.filter(
      (l) => l.direction === 'payout' && l.req.member.id === w.supplier,
    );
    expect(payouts.map((p) => p.req.amount)).toEqual([eur('12880')]);
    expect(rail.log.filter((l) => l.direction === 'collect')).toHaveLength(0);

    for (const m of [w.brand, w.supplier, w.retailer]) {
      const positions = await deps().ledger.balances(deps().db, w.tenantId, {
        memberId: m,
        kinds: ['settlement'],
      });
      expect(positions.length).toBeGreaterThan(0);
      for (const b of positions) expect(b.balance).toBe(0n);
    }
  });

  it('rejects an order over the mandate before any money moves', async () => {
    const w = await makeWorld(rail, undefined, { EUR: { monthlyLimit: eur('20000') } });
    const deal = await w.deal({
      buyer: 'brand',
      seller: 'supplier',
      quantity: 10_000,
      price: '14',
    });
    const done = await waitFor(deal.id, ['rejected']);
    expect(done.statusReason).toMatch(/monthly limit/);
  });

  it('freezes a 10x order and binds the decision to what was shown', async () => {
    const w = await makeWorld(rail);
    const { big, case: c } = await frozenBigOrder(w);
    expect(c.reason).toMatch(/far larger/);
    await expect(
      decideCase(c.id, w.person, {
        bindingHash: 'stale',
        rationale: 'Checked against the evidence',
        action: { type: 'confirm' },
      }),
    ).rejects.toThrow(/no longer matches/);
    await personDecides(w, c.id, {
      bindingHash: c.bindingHash,
      rationale: 'Checked against the evidence',
      action: { type: 'cancel' },
    });
    await waitFor(big.id, ['cancelled']);
  });

  it('holds a mismatch beyond tolerance until it is waived', async () => {
    brain.current = undefined;
    const w = await makeWorld(rail);
    await w.fund(w.retailer, 'EUR', eur('1500'));
    await w.fund(w.brand, 'GBP', gbp('500'));
    const deal = await w.deal({ buyer: 'retailer', seller: 'brand', quantity: 100, price: '15' });
    await waitFor(deal.id, ['awaiting_conditions']);
    await w.pass(deal.id, { amount: eur('1500'), quantity: 100, shipped: '2026-11-09' });
    await waitFor(deal.id, ['held']);

    const c = await waitForCase(w.tenantId, { dealId: deal.id });
    expect(c.reason).toMatch(/shows shipment 7 days after the agreed date/);
    // The hold names the document that failed, so every screen can mark it.
    const { db } = deps();
    const [held] = await db
      .select()
      .from(dealEvents)
      .where(and(eq(dealEvents.dealId, deal.id), eq(dealEvents.type, 'held')));
    const filed = await db.select().from(dealFacts).where(eq(dealFacts.dealId, deal.id));
    const findings = held?.payload.findings as { factId?: string; message: string }[];
    expect(findings.length).toBeGreaterThan(0);
    for (const f of findings) expect(filed.map((x) => x.id)).toContain(f.factId);
    await personDecides(w, c.id, {
      bindingHash: c.bindingHash,
      rationale: 'Checked against the evidence',
      action: { type: 'waive' },
    });
    const done = await waitFor(deal.id, ['eligible']);
    expect(done.releaseAmount).toBe(eur('1500'));
  });

  it('waits for funding, then resumes on deposit', async () => {
    const w = await makeWorld(rail);
    await w.fund(w.brand, 'GBP', gbp('5000'));
    const deal = await w.deal({ buyer: 'retailer', seller: 'brand', quantity: 1_000, price: '15' });
    await waitFor(deal.id, ['awaiting_funding']);
    await w.fund(w.retailer, 'EUR', eur('15000'));
    await waitFor(deal.id, ['awaiting_conditions']);
    expect(await w.available(w.retailer, 'EUR')).toBe(0n);
    // Unused facts cannot be submitted by the wrong party.
    await expect(
      submitFact(deal.id, w.asMember(w.brand), {
        kind: 'inspection',
        type: 'x',
        data: { passRate: 1 },
      }),
    ).rejects.toThrow(/may not assert/);
  });
});
