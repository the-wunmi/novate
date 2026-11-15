import { describe, expect, it } from 'vitest';
import { marginRequirement, type OpenExposure } from '../src/index.ts';

const E8 = 100_000_000n;
const params = { baseBps: 500, stressMultiple: 2.33, horizonDays: 2, crossOffsetBps: 5_000 };
const eurToGbp = (rate: number) => BigInt(Math.round(rate * 1e8));
const pos = (currency: string, amount: bigint, booked = E8): OpenExposure => ({
  currency,
  amount,
  bookedRateE8: booked,
});
const need = (exposures: OpenExposure[], rate = 0.87, vol = 0.06) =>
  marginRequirement(
    { home: 'GBP', exposures, rate: () => eurToGbp(rate), volatility: () => vol },
    params,
  );

describe('portfolio margin', () => {
  it('holds only the base rate against a home currency payable', () => {
    const r = marginRequirement(
      { home: 'EUR', exposures: [pos('EUR', -100_000n)], rate: () => E8, volatility: () => 0 },
      params,
    );
    expect(r).toMatchObject({ exposure: 100_000n, base: 5_000n, stress: 0n, variation: 0n });
  });

  it('asks for nothing from a member who is only owed money', () => {
    expect(need([pos('EUR', 500_000n, eurToGbp(0.87))]).required).toBe(0n);
  });

  it('nets offsetting positions in a currency before sizing anything', () => {
    const booked = eurToGbp(0.87);
    const gross = need([pos('EUR', -1_000_000n, booked)]);
    const netted = need([pos('EUR', -1_000_000n, booked), pos('EUR', 800_000n, booked)]);
    expect(netted.exposure).toBeLessThan(gross.exposure / 4n);
    expect(netted.required).toBeLessThan(gross.required / 4n);
  });

  it('only partly offsets a payable with a receivable in another currency', () => {
    const r = marginRequirement(
      {
        home: 'EUR',
        exposures: [pos('EUR', -100_000n), pos('GBP', 50_000n, eurToGbp(1.15))],
        rate: () => eurToGbp(1.15),
        volatility: () => 0.05,
      },
      params,
    );
    // 57,500 of receivable at a 50% haircut offsets 28,750 of the payable.
    expect(r.exposure).toBe(100_000n - 28_750n);
  });

  it('adds stress for foreign payables and scales it with volatility', () => {
    const calm = need([pos('EUR', -1_000_000n, eurToGbp(0.87))], 0.87, 0.05);
    const wild = need([pos('EUR', -1_000_000n, eurToGbp(0.87))], 0.87, 0.3);
    expect(calm.stress).toBeGreaterThan(0n);
    expect(wild.stress).toBeGreaterThan(calm.stress * 5n);
  });

  it('collateralises the loss when the rate moves against a payable', () => {
    const r = need([pos('EUR', -1_000_000n, eurToGbp(0.87))], 0.95);
    // 10,000 EUR cost 8,700 GBP when booked and 9,500 now.
    expect(r.variation).toBe(80_000n);
    expect(r.required).toBe(r.base + r.stress + r.variation);
  });

  it('gives no credit for a gain, but does not let it make the requirement negative', () => {
    const r = need([pos('EUR', -1_000_000n, eurToGbp(0.87))], 0.8);
    expect(r.variation).toBe(0n);
    expect(r.required).toBe(r.base + r.stress);
    expect(r.required).toBeGreaterThan(0n);
  });
});
