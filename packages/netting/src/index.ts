import type { Currency } from '@novate/core';

export interface NettableObligation {
  id: string;
  payer: string;
  payee: string;
  currency: Currency;
  amount: bigint;
  /** Buyer funds already held by the house against this obligation. */
  prefunded: bigint;
}

export type NettingMode = 'multilateral' | 'bilateral' | 'gross';

export interface Position {
  member: string;
  currency: Currency;
  payable: bigint;
  receivable: bigint;
  /** receivable − payable. Positive: the house owes the member. */
  net: bigint;
  /** Funds already held for this member's payables in this cycle. */
  prefunded: bigint;
  /** What the member must pay in. Never negative: money owed to it is `payout`. */
  collect: bigint;
  payout: bigint;
}

export interface NettingResult {
  mode: NettingMode;
  positions: Position[];
  /** Per currency: what would move gross vs. what moves after netting. */
  totals: Record<
    string,
    { gross: bigint; net: bigint; transfersGross: number; transfersNet: number }
  >;
}

const key = (member: string, currency: string) => `${member}\u0000${currency}`;

/**
 * Multilateral netting: every member ends with one position per currency against the house.
 * Prefunded amounts already sit with the house, so they reduce what must be collected.
 *
 * Invariant (per currency): Σ net = 0 and Σ collect + Σ prefunded = Σ payout.
 */
export function net(
  obligations: NettableObligation[],
  mode: NettingMode = 'multilateral',
): NettingResult {
  if (mode !== 'multilateral') return netPairwise(obligations, mode);

  const positions = new Map<string, Position>();
  const pos = (member: string, currency: Currency) => {
    const k = key(member, currency);
    let p = positions.get(k);
    if (!p) {
      p = {
        member,
        currency,
        payable: 0n,
        receivable: 0n,
        net: 0n,
        prefunded: 0n,
        collect: 0n,
        payout: 0n,
      };
      positions.set(k, p);
    }
    return p;
  };

  for (const o of obligations) {
    if (o.amount <= 0n) throw new Error(`Obligation ${o.id} must be positive`);
    if (o.prefunded < 0n || o.prefunded > o.amount) {
      throw new Error(`Obligation ${o.id} prefunded amount out of range`);
    }
    const payer = pos(o.payer, o.currency);
    payer.payable += o.amount;
    payer.prefunded += o.prefunded;
    pos(o.payee, o.currency).receivable += o.amount;
  }

  for (const p of positions.values()) {
    p.net = p.receivable - p.payable;
    const finalBalance = p.prefunded + p.net;
    if (finalBalance < 0n) p.collect = -finalBalance;
    else p.payout = finalBalance;
  }

  const list = sorted(positions);
  return { mode, positions: list, totals: totals(obligations, list) };
}

/**
 * Bilateral and gross modes still produce per-member positions so settlement is uniform; they
 * differ in which obligations may offset each other (same pair only, or none).
 */
function netPairwise(
  obligations: NettableObligation[],
  mode: 'bilateral' | 'gross',
): NettingResult {
  const groups = new Map<string, NettableObligation[]>();
  for (const o of obligations) {
    const g = mode === 'gross' ? o.id : [o.currency, ...[o.payer, o.payee].sort()].join('\u0000');
    groups.set(g, [...(groups.get(g) ?? []), o]);
  }
  const merged = new Map<string, Position>();
  for (const group of groups.values()) {
    for (const p of net(group, 'multilateral').positions) {
      const k = key(p.member, p.currency);
      const m = merged.get(k);
      if (!m) merged.set(k, { ...p });
      else {
        m.payable += p.payable;
        m.receivable += p.receivable;
        m.net += p.net;
        m.prefunded += p.prefunded;
        m.collect += p.collect;
        m.payout += p.payout;
      }
    }
  }
  const list = sorted(merged);
  return { mode, positions: list, totals: totals(obligations, list) };
}

const sorted = (positions: Map<string, Position>) =>
  [...positions.values()].sort(
    (a, b) => a.currency.localeCompare(b.currency) || a.member.localeCompare(b.member),
  );

function totals(obligations: NettableObligation[], positions: Position[]): NettingResult['totals'] {
  const out: NettingResult['totals'] = {};
  for (const o of obligations) {
    const t = out[o.currency] ?? { gross: 0n, net: 0n, transfersGross: 0, transfersNet: 0 };
    out[o.currency] = t;
    t.gross += o.amount;
    t.transfersGross += 2; // collect from payer + pay out to payee
  }
  for (const p of positions) {
    const t = out[p.currency];
    if (!t) continue;
    t.net += p.collect + p.payout;
    t.transfersNet += (p.collect > 0n ? 1 : 0) + (p.payout > 0n ? 1 : 0);
  }
  return out;
}
