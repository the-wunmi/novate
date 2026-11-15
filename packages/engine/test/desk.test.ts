import { type ProgramSpecInput, presetInputs } from '@novate/policy';
import { MockRail } from '@novate/rails';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { deskView, runCycle, runReconciliation, submitFact } from '../src/index.ts';
import { boot, eur, makeWorld, shutdown, waitFor } from './harness.ts';

const rail = new MockRail({ pull: false });
beforeAll(async () => {
  await boot(rail);
});
afterAll(() => shutdown());

const net: ProgramSpecInput = {
  ...presetInputs.netSettlement,
  overrides: [],
  settlement: { netting: 'multilateral', rail: 'mock', fundingWindow: '30s', confirmWithin: '1h' },
};

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
    await runReconciliation(w.tenantId, 'mock');

    const desk = await deskView(w.tenantId);
    const [cycle] = desk.cycles;
    expect(cycle?.owed.map((o) => o.amount).sort()).toEqual([eur('2000'), eur('50')].sort());
    expect(cycle?.paid.every((p) => p.status === 'confirmed')).toBe(true);
    expect(desk.books).toMatchObject([{ rail: 'mock', status: 'clean' }]);
    const retailer = desk.members.find((m) => m.id === w.retailer);
    expect(retailer?.available).toEqual([{ currency: 'EUR', amount: eur('50') }]);
  });

  it('is empty, not broken, before anything has settled', async () => {
    const w = await makeWorld(rail);
    expect(await deskView(w.tenantId)).toMatchObject({ cycles: [], books: [], lockedInDeals: [] });
  });
});
