import { railCursors } from '@novate/db';
import { MetalRail } from '@novate/rails';
import { eq } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { FakeMetal } from '../../rails/test/fake-metal.ts';
import { PostgresMetalAttempts, pollRailEvents, runCycle, submitFact } from '../src/index.ts';
import {
  assignRailRefs,
  boot,
  brain,
  makeWorld,
  netProgram,
  reconcile,
  shutdown,
  waitFor,
} from './harness.ts';

const CENT = 10n ** 16n;
const chain = new FakeMetal();
const rail = new MetalRail(chain, new PostgresMetalAttempts());

const program = netProgram({
  settlement: { netting: 'multilateral', rail: 'metal', fundingWindow: '30s', confirmWithin: '1h' },
  decisions: { ceiling: { USD: 5_000_000 } },
});

beforeAll(async () => {
  const engine = await boot(rail);
  // A new stand-in chain has no history to catch up on.
  await engine.db.delete(railCursors).where(eq(railCursors.rail, 'metal'));
});
afterAll(() => shutdown());

describe('settling on Metal', () => {
  it('funds from a finalized deposit, pays once, and reconciles', async () => {
    brain.current = undefined;
    const finalizing = setInterval(() => chain.finalize(), 50);
    const w = await makeWorld(rail as never, { metal: program });
    const unique = w.tenantId.slice(0, 8);
    const buyerWallet = `0xBuyer${unique}`;
    await assignRailRefs(w, w.retailer, { metal_deposit_account: buyerWallet });
    await assignRailRefs(w, w.supplier, { metal_account: `0xSupplier${unique}` });

    await pollRailEvents(rail);
    chain.credit(buyerWallet, 150n * 100n * CENT);
    await pollRailEvents(rail);
    await expect.poll(() => w.available(w.retailer, 'USD'), { timeout: 15_000 }).toBe(15_000n);

    const d = await w.deal({
      program: 'metal',
      buyer: 'retailer',
      seller: 'supplier',
      quantity: 10,
      price: '15',
      extra: { currency: 'USD' },
    });
    await waitFor(d.id, ['awaiting_conditions']);
    await submitFact(d.id, w.asMember(w.retailer), { kind: 'acceptance', type: 'buyer', data: {} });
    await waitFor(d.id, ['eligible']);

    expect((await runCycle(w.tenantId)).status).toBe('settled');
    await waitFor(d.id, ['settled']);
    clearInterval(finalizing);
    expect(chain.signed).toBe(1);
    expect(await chain.balance()).toBe(0n);
    expect((await reconcile(w.tenantId, 'metal')).breaks).toEqual([]);
  });
});
