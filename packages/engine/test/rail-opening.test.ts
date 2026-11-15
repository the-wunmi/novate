import { MockRail } from '@novate/rails';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { deposit, type Engine, recordRailOpening } from '../src/index.ts';
import { boot, eur, makeWorld, reconcile, shutdown } from './harness.ts';

const main = new MockRail();
let engine: Engine;

beforeAll(async () => {
  engine = await boot(main);
});
afterAll(() => shutdown());

/** A rail of its own, because each test's account starts with a different history. */
function account(name: string) {
  const rail = new MockRail({ name });
  engine.rails.register(rail);
  return rail;
}

describe('money already on the account when a rail is connected', () => {
  it('is left out of later reconciliation', async () => {
    const w = await makeWorld(main);
    const rail = account('funded-before');
    rail.simulateDeposit('EUR', eur('5000'), 'before-novate');
    await recordRailOpening(w.tenantId, 'funded-before');
    expect(await reconcile(w.tenantId, 'funded-before')).toMatchObject({
      status: 'clean',
      halted: false,
    });
  });

  it('still stops settlement for unknown money arriving afterwards', async () => {
    const w = await makeWorld(main);
    const rail = account('funded-after');
    rail.simulateDeposit('EUR', eur('5000'), 'before-novate');
    await recordRailOpening(w.tenantId, 'funded-after');
    rail.simulateDeposit('EUR', eur('7'), 'unexplained');
    const result = await reconcile(w.tenantId, 'funded-after');
    expect(result.halted).toBe(true);
    expect(result.breaks.map((b) => b.externalRef ?? b.expected)).toEqual([
      eur('5000'),
      'unexplained',
    ]);
  });

  it('notices the opening money leaving', async () => {
    const w = await makeWorld(main);
    const rail = account('drained');
    rail.simulateDeposit('EUR', eur('5000'), 'before-novate');
    await recordRailOpening(w.tenantId, 'drained');
    rail.corrupt('EUR', -eur('5000'));
    const result = await reconcile(w.tenantId, 'drained');
    expect(result.breaks[0]).toMatchObject({
      kind: 'balance_mismatch',
      expected: eur('5000'),
      actual: 0n,
    });
  });

  it('is only recorded once', async () => {
    const w = await makeWorld(main);
    const rail = account('opened-twice');
    rail.simulateDeposit('EUR', eur('5000'), 'before-novate');
    await recordRailOpening(w.tenantId, 'opened-twice');
    rail.corrupt('EUR', eur('1'));
    await recordRailOpening(w.tenantId, 'opened-twice');
    expect((await reconcile(w.tenantId, 'opened-twice')).status).toBe('breaks');
  });

  it('books a rail fee on known money as a house cost, even in a currency nobody holds', async () => {
    const w = await makeWorld(main);
    const rail = account('fee-charged');
    await recordRailOpening(w.tenantId, 'fee-charged');
    rail.simulateDeposit('EUR', eur('100'), 'dep-1');
    await deposit(w.tenantId, {
      memberId: w.retailer,
      currency: 'EUR',
      amount: eur('100'),
      rail: 'fee-charged',
      externalRef: 'dep-1',
    });
    rail.simulateFee('USD', 1500n, 'dep-1');
    expect((await reconcile(w.tenantId, 'fee-charged')).status).toBe('clean');
    // Posted once, however many times it is seen.
    expect((await reconcile(w.tenantId, 'fee-charged')).status).toBe('clean');

    rail.simulateDeposit('EUR', eur('40'), 'dep-2');
    await deposit(w.tenantId, {
      memberId: w.retailer,
      currency: 'EUR',
      amount: eur('40'),
      rail: 'fee-charged',
      externalRef: 'dep-2',
    });
    rail.simulateFee('USD', 1500n, 'dep-2');
    expect((await reconcile(w.tenantId, 'fee-charged')).status).toBe('clean');
  });

  it('still stops for a fee on something it does not recognise', async () => {
    const w = await makeWorld(main);
    const rail = account('fee-unknown');
    await recordRailOpening(w.tenantId, 'fee-unknown');
    rail.simulateFee('USD', 1500n, 'never-seen');
    expect((await reconcile(w.tenantId, 'fee-unknown')).halted).toBe(true);
  });
});
