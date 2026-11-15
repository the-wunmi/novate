import { describe, expect, it } from 'vitest';
import { SignalRegistry, StaticSignalProvider } from '../src/index.ts';

const subject = {
  tenantId: 't',
  buyerMemberId: 'b',
  sellerMemberId: 's',
  currency: 'EUR',
  amount: 1n,
  category: 'c',
  attributes: {},
};
const broken = (fallback?: Record<string, unknown>) =>
  new StaticSignalProvider(
    'x',
    () => {
      throw new Error('down');
    },
    fallback,
  );

describe('signals', () => {
  it('uses the fallback when a provider fails, and says so', async () => {
    const r = await new SignalRegistry().register(broken({ v: 1 })).resolve(['x'], subject);
    expect(r.x).toMatchObject({ values: { v: 1 }, source: 'fallback' });
  });
  it('fails when there is no fallback', async () => {
    await expect(new SignalRegistry().register(broken()).resolve(['x'], subject)).rejects.toThrow(
      /down/,
    );
  });
  it('fails on an unregistered provider', async () => {
    await expect(new SignalRegistry().resolve(['nope'], subject)).rejects.toThrow(/no provider/);
  });
});
