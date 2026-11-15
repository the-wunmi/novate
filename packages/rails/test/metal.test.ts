import { describe, expect, it } from 'vitest';
import { MemoryMetalAttempts, MetalRail } from '../src/index.ts';
import { FakeMetal } from './fake-metal.ts';

const CENT = 10n ** 16n;
const make = () => {
  const chain = new FakeMetal();
  const store = new MemoryMetalAttempts();
  return { chain, store, rail: new MetalRail(chain, store) };
};
const req = {
  idempotencyKey: 'k1',
  member: { id: 'm', railRefs: { metal_account: '0xPayee' } },
  currency: 'USD',
  amount: 1_288_000n,
  reference: 'r',
};

describe('metal rail', () => {
  it('saves what it signed before broadcasting', async () => {
    const { chain, store, rail } = make();
    chain.dropNext = true;
    const r = await rail.payout(req);
    expect(r.status).toBe('submitted');
    expect(store.rows).toHaveLength(1);
  });

  it('never signs a second payment after a lost reply', async () => {
    const { chain, rail } = make();
    chain.dropNext = true;
    const first = await rail.payout(req);
    const second = await rail.payout(req);
    expect(second.externalRef).toBe(first.externalRef);
    expect(chain.signed).toBe(1);
    // The same signed bytes went out again, not a new payment.
    expect(new Set(chain.broadcasts).size).toBe(1);
  });

  it('fails a refused broadcast and frees it, so a later payout is not blocked', async () => {
    const { chain, store, rail } = make();
    chain.refuseNext = true;
    const r = await rail.payout(req);
    expect(r).toMatchObject({ status: 'failed', reason: 'insufficient gas-token balance' });
    expect(store.rows).toHaveLength(0);
    // Nothing was accepted, so the same key can be signed again.
    expect((await rail.payout(req)).status).toBe('submitted');
    expect(store.rows).toHaveLength(1);
  });

  it('signs concurrent payouts one at a time', async () => {
    const { chain, rail } = make();
    const results = await Promise.all([
      rail.payout(req),
      rail.payout({ ...req, idempotencyKey: 'k2' }),
    ]);
    expect(new Set(results.map((r) => r.externalRef)).size).toBe(2);
    expect(chain.signed).toBe(2);
  });

  it('is only confirmed once finalized', async () => {
    const { chain, rail } = make();
    chain.credit('0xFunder', 2_000_000n * CENT);
    const { externalRef } = await rail.payout(req);
    expect((await rail.status(externalRef)).status).toBe('submitted');
    chain.finalize();
    expect((await rail.status(externalRef)).status).toBe('confirmed');
  });

  it('reports a revert as failed', async () => {
    const { chain, rail } = make();
    chain.outcome = 'revert';
    const { externalRef } = await rail.payout(req);
    chain.finalize();
    expect((await rail.status(externalRef)).status).toBe('failed');
  });

  it('does not confirm a quarantined transfer, and does not fail it either', async () => {
    const { chain, rail } = make();
    chain.credit('0xFunder', 2_000_000n * CENT);
    chain.outcome = 'quarantine';
    const { externalRef } = await rail.payout(req);
    chain.finalize();
    expect((await rail.status(externalRef)).status).toBe('submitted');
  });

  it('refuses other currencies and members with no account', async () => {
    const { chain, rail } = make();
    expect((await rail.payout({ ...req, currency: 'EUR' })).status).toBe('failed');
    expect((await rail.payout({ ...req, member: { id: 'x', railRefs: {} } })).status).toBe(
      'failed',
    );
    expect(chain.signed).toBe(0);
  });

  it('turns finalized deposits into events and moves the cursor', async () => {
    const { chain, rail } = make();
    const start = await rail.pollEvents(null);
    chain.credit('0xFunder', 150n * CENT);
    chain.credit(chain.tokenAddress, 5n * CENT);
    const polled = await rail.pollEvents(start.cursor);
    expect(polled.events).toHaveLength(1);
    expect(polled.events[0]).toMatchObject({
      type: 'deposit.settled',
      amount: 150n,
      depositAccountRef: '0xfunder',
    });
    expect(polled.caughtUp).toBe(true);
    expect((await rail.pollEvents(polled.cursor)).events).toEqual([]);
  });

  it('recovers from a position past the head of the chain instead of stopping', async () => {
    const { chain, rail } = make();
    const stranded = await rail.pollEvents(10n ** 15n);
    chain.credit('0xFunder', 150n * CENT);
    expect((await rail.pollEvents(stranded.cursor)).events).toHaveLength(1);
  });

  it('has no webhooks and no FX', async () => {
    const { rail } = make();
    expect(rail.capabilities.signedEvents).toBe(false);
    await expect(rail.quote('USD', 'EUR')).rejects.toThrow(/no FX/);
  });
});
