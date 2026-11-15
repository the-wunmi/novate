import type { ReconRunSummary } from '@novate/db';
import { MockRail } from '@novate/rails';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  comparisonOf,
  cycleDetail,
  listPrograms,
  railBooks,
  recentCycles,
  reconHistory,
  runCycle,
  submitFact,
} from '../src/index.ts';
import {
  boot,
  eur,
  makeWorld,
  netProgram,
  owning,
  reconcile,
  shutdown,
  waitFor,
} from './harness.ts';

const rail = new MockRail({ pull: false });
beforeAll(async () => {
  await boot(rail);
});
afterAll(() => shutdown());

const net = netProgram({
  settlement: { netting: 'multilateral', rail: 'mock', fundingWindow: '30s', confirmWithin: '1h' },
});

describe('the clearing desk', () => {
  it('shows what was owed against what actually moved, and whether the books match', async () => {
    const w = await makeWorld(rail, { net });
    await w.fund(w.retailer, 'EUR', eur('2100'));
    const one = await w.deal({
      program: 'net',
      buyer: 'retailer',
      seller: 'supplier',
      quantity: 400,
      price: '5',
    });
    const two = await w.deal({
      program: 'net',
      buyer: 'retailer',
      seller: 'brand',
      quantity: 10,
      price: '5',
    });
    for (const id of [one.id, two.id]) {
      await waitFor(id, ['awaiting_conditions']);
      await submitFact(id, w.asMember(w.retailer), { kind: 'acceptance', type: 'buyer', data: {} });
      await waitFor(id, ['eligible']);
    }
    await runCycle(w.tenantId);
    await waitFor(one.id, ['settled']);
    await waitFor(two.id, ['settled']);
    await reconcile(w.tenantId, 'mock');

    const [cycle] = await recentCycles(w.tenantId);
    expect(cycle?.owed.map((o) => o.amount).sort()).toEqual([eur('2000'), eur('50')].sort());
    expect(cycle?.paid.every((p) => p.status === 'confirmed')).toBe(true);
    expect(cycle?.settlement).toMatchObject({ rail: 'mock', netting: 'multilateral' });
    expect(cycle?.owed.map((o) => o.dealId).sort()).toEqual([one.id, two.id].sort());

    // Each owned rail as it stands: checked clean, and everything that moved is members' money.
    const [books] = await owning(w.tenantId, 'mock', () => railBooks(w.tenantId));
    expect(books).toMatchObject({
      rail: 'mock',
      latest: { status: 'clean', breaks: [] },
      differencesSince: null,
      openDifferences: 0,
    });

    // A cycle's own page stands alone: what was owed, what was converted and each member's net.
    const detail = await cycleDetail(w.tenantId, cycle?.id as string);
    expect(detail.cycle.owed.map((o) => o.dealId).sort()).toEqual([one.id, two.id].sort());
    expect(detail.cycle.converted).toEqual([]);
    const position = (memberId: string) => detail.positions.find((p) => p.memberId === memberId);
    expect(position(w.retailer)).toEqual({
      memberId: w.retailer,
      currency: 'EUR',
      owes: eur('2050'),
      owed: 0n,
      net: -eur('2050'),
    });
    expect(position(w.supplier)).toMatchObject({ owes: 0n, owed: eur('2000'), net: eur('2000') });
    expect(position(w.brand)).toMatchObject({ net: eur('50') });

    // The books page shows each currency as the ledger and the rail see it.
    const [run] = (await reconHistory(w.tenantId)).rows;
    expect(run).toMatchObject({ rail: 'mock', status: 'clean', breaks: [] });
    const eurPosition = comparisonOf(run?.summary as ReconRunSummary).positions.find(
      (p) => p.currency === 'EUR',
    );
    expect(eurPosition?.ledger).toBe(eurPosition?.rail);

    const programs = await listPrograms(w.tenantId);
    expect(programs.find((p) => p.key === 'net')).toMatchObject({ version: 1, deals: 2 });
  });

  it('is empty, not broken, before anything has settled', async () => {
    const w = await makeWorld(rail);
    expect(await recentCycles(w.tenantId)).toEqual([]);
    expect(await railBooks(w.tenantId)).toEqual([]);
  });
});
