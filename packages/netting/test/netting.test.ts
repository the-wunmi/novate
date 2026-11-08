import { describe, expect, it } from 'vitest';
import { type NettableObligation, net } from '../src/index.ts';

const o = (
  id: string,
  payer: string,
  payee: string,
  amount: bigint,
  prefunded = amount,
): NettableObligation => ({
  id,
  payer,
  payee,
  currency: 'EUR',
  amount,
  prefunded,
});

const invariant = (r: ReturnType<typeof net>) => {
  const byCcy = new Map<string, { net: bigint; in: bigint; out: bigint }>();
  for (const p of r.positions) {
    const t = byCcy.get(p.currency) ?? { net: 0n, in: 0n, out: 0n };
    t.net += p.net;
    t.in += p.collect + p.prefunded;
    t.out += p.payout;
    byCcy.set(p.currency, t);
  }
  for (const t of byCcy.values()) {
    expect(t.net).toBe(0n);
    expect(t.in).toBe(t.out);
  }
};

describe('net', () => {
  it('mug scenario, prefunded: brand gets its excess back, supplier is paid', () => {
    const r = net([
      o('buy', 'brand', 'supplier', 1_288_000n),
      o('sell', 'retailer', 'brand', 900_000n),
    ]);
    const brand = r.positions.find((p) => p.member === 'brand');
    expect(brand?.net).toBe(-388_000n);
    expect(brand?.collect).toBe(0n);
    expect(brand?.payout).toBe(900_000n); // 12,880 locked − 3,880 net owed
    expect(r.positions.find((p) => p.member === 'supplier')?.payout).toBe(1_288_000n);
    invariant(r);
  });

  it('mug scenario, net-then-fund: brand pays only the €3,880 difference', () => {
    const r = net([
      o('buy', 'brand', 'supplier', 1_288_000n, 0n),
      o('sell', 'retailer', 'brand', 900_000n, 0n),
    ]);
    const brand = r.positions.find((p) => p.member === 'brand');
    expect(brand?.collect).toBe(388_000n);
    expect(brand?.payout).toBe(0n);
    expect(r.totals.EUR?.net).toBe(388_000n + 900_000n + 1_288_000n);
    expect(r.totals.EUR?.gross).toBe(2_188_000n);
    invariant(r);
  });

  it('a circular chain nets to nothing', () => {
    const r = net([
      o('1', 'a', 'b', 100n, 0n),
      o('2', 'b', 'c', 100n, 0n),
      o('3', 'c', 'a', 100n, 0n),
    ]);
    expect(r.positions.every((p) => p.collect === 0n && p.payout === 0n)).toBe(true);
    expect(r.totals.EUR?.transfersNet).toBe(0);
  });

  it('bilateral only offsets within a pair', () => {
    const obligations = [
      o('1', 'a', 'b', 100n, 0n),
      o('2', 'b', 'c', 100n, 0n),
      o('3', 'c', 'a', 100n, 0n),
    ];
    const r = net(obligations, 'bilateral');
    expect(r.positions.find((p) => p.member === 'a')?.collect).toBe(100n);
    expect(r.positions.find((p) => p.member === 'a')?.payout).toBe(100n);
    invariant(r);
  });

  it('keeps currencies separate', () => {
    const r = net([
      { ...o('1', 'a', 'b', 100n, 0n), currency: 'EUR' },
      { ...o('2', 'b', 'a', 100n, 0n), currency: 'USD' },
    ]);
    expect(r.positions).toHaveLength(4);
    invariant(r);
  });
});
