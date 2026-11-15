import { describe, expect, it } from 'vitest';
import { planFx, realisedVolatility } from '../src/index.ts';

const E8 = 100_000_000n;
const rate = (sell: string, buy: string) =>
  sell === 'GBP' && buy === 'EUR'
    ? (115n * E8) / 100n
    : sell === 'EUR' && buy === 'GBP'
      ? (87n * E8) / 100n
      : undefined;

describe('planFx', () => {
  it('buys only the net shortfall from a member’s home-currency collateral', () => {
    const net = planFx(
      [{ member: 'brand', currency: 'EUR', amount: 388_000n }],
      [{ member: 'brand', currency: 'GBP', amount: 1_250_000n }],
      rate,
    );
    expect(net.conversions).toEqual([
      { sellCurrency: 'GBP', buyCurrency: 'EUR', buyAmount: 388_000n },
    ]);
    expect(net.exchanges[0]?.sellAmount).toBe(337_392n);
    expect(net.uncovered).toEqual([]);
  });

  it('reports what collateral cannot cover', () => {
    const net = planFx(
      [{ member: 'brand', currency: 'EUR', amount: 388_000n }],
      [{ member: 'brand', currency: 'GBP', amount: 100_000n }],
      rate,
    );
    expect(net.exchanges[0]?.buyAmount).toBe(115_000n);
    expect(net.uncovered).toEqual([{ member: 'brand', currency: 'EUR', amount: 273_000n }]);
  });

  it('pools opposite flows between members before going to market', () => {
    const net = planFx(
      [
        { member: 'a', currency: 'EUR', amount: 115_000n },
        { member: 'b', currency: 'GBP', amount: 50_000n },
      ],
      [
        { member: 'a', currency: 'GBP', amount: 100_000n },
        { member: 'b', currency: 'EUR', amount: 100_000n },
      ],
      rate,
    );
    expect(net.conversions).toHaveLength(1);
    expect(net.exchanges).toHaveLength(2);
  });

  it('does not convert when the need is already in the collateral currency', () => {
    const net = planFx(
      [{ member: 'a', currency: 'EUR', amount: 100n }],
      [{ member: 'a', currency: 'EUR', amount: 100n }],
      rate,
    );
    expect(net.conversions).toEqual([]);
    expect(net.uncovered).toEqual([{ member: 'a', currency: 'EUR', amount: 100n }]);
  });
});

describe('realisedVolatility', () => {
  it('is zero for a flat rate', () => {
    expect(realisedVolatility([1.15, 1.15, 1.15, 1.15], 8760)).toBe(0);
  });
  it('annualises hourly moves', () => {
    const rates = [1, 1.001, 1, 1.001, 1];
    expect(realisedVolatility(rates, 8760)).toBeCloseTo(0.108, 3);
  });
  it('needs at least three rates', () => {
    expect(realisedVolatility([1, 2], 8760)).toBe(0);
  });
});
