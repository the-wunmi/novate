import { type Currency, fxBuyAmount, fxSellAmount, minBig } from '@novate/core';

/** Money a member has locked in one currency that may be sold to meet a need in another. */
export interface FxCollateral {
  member: string;
  currency: Currency;
  amount: bigint;
}

/** A member's net shortfall in a currency. */
export interface FxNeed {
  member: string;
  currency: Currency;
  amount: bigint;
}

/** Sell `sellCurrency` from a member's collateral to buy some of what it owes. */
export interface MemberExchange {
  member: string;
  sellCurrency: Currency;
  buyCurrency: Currency;
  sellAmount: bigint;
  buyAmount: bigint;
}

/** What actually goes to the market for one currency pair. */
export interface MarketConversion {
  sellCurrency: Currency;
  buyCurrency: Currency;
  buyAmount: bigint;
}

export interface FxPlan {
  exchanges: MemberExchange[];
  conversions: MarketConversion[];
  /** Needs that collateral could not cover; these fall through to wallet, rail or deposit. */
  uncovered: FxNeed[];
}

export type RateTable = (sell: Currency, buy: Currency) => bigint | undefined;

const pair = (sell: string, buy: string) => `${sell}\u0000${buy}`;

/**
 * Plan how members' locked funds in other currencies meet their net shortfalls. Pure. Shortfalls
 * are already net of receivables, and opposite flows between members are pooled before market.
 */
export function planFx(needs: FxNeed[], collateral: FxCollateral[], rate: RateTable): FxPlan {
  const remaining = new Map<string, bigint>();
  const keyOf = (member: string, currency: string) => `${member}\u0000${currency}`;
  for (const c of collateral) {
    const k = keyOf(c.member, c.currency);
    remaining.set(k, (remaining.get(k) ?? 0n) + c.amount);
  }

  const exchanges: MemberExchange[] = [];
  const uncovered: FxNeed[] = [];
  for (const need of [...needs].sort(
    (a, b) => a.member.localeCompare(b.member) || a.currency.localeCompare(b.currency),
  )) {
    let left = need.amount;
    const sources = collateral
      .filter((c) => c.member === need.member && c.currency !== need.currency)
      .map((c) => c.currency);
    for (const sellCurrency of [...new Set(sources)].sort()) {
      if (left === 0n) break;
      const r = rate(sellCurrency, need.currency);
      if (r === undefined) continue;
      const k = keyOf(need.member, sellCurrency);
      const available = remaining.get(k) ?? 0n;
      if (available === 0n) continue;
      const wanted = fxSellAmount(left, r, sellCurrency, need.currency);
      const sellAmount = minBig(wanted, available);
      const buyAmount = minBig(fxBuyAmount(sellAmount, r, sellCurrency, need.currency), left);
      if (buyAmount === 0n) continue;
      remaining.set(k, available - sellAmount);
      left -= buyAmount;
      exchanges.push({
        member: need.member,
        sellCurrency,
        buyCurrency: need.currency,
        sellAmount,
        buyAmount,
      });
    }
    if (left > 0n) uncovered.push({ member: need.member, currency: need.currency, amount: left });
  }

  return { exchanges, conversions: poolConversions(exchanges, rate), uncovered };
}

/** Offset opposite flows, so two members swapping GBP and EUR send only the difference to market. */
function poolConversions(exchanges: MemberExchange[], rate: RateTable): MarketConversion[] {
  const flows = new Map<string, { sell: Currency; buy: Currency; buyAmount: bigint }>();
  for (const e of exchanges) {
    const k = pair(e.sellCurrency, e.buyCurrency);
    const f = flows.get(k) ?? { sell: e.sellCurrency, buy: e.buyCurrency, buyAmount: 0n };
    f.buyAmount += e.buyAmount;
    flows.set(k, f);
  }
  const out: MarketConversion[] = [];
  const done = new Set<string>();
  for (const [k, f] of flows) {
    if (done.has(k)) continue;
    const reverseKey = pair(f.buy, f.sell);
    const reverse = flows.get(reverseKey);
    done.add(k);
    done.add(reverseKey);
    if (!reverse) {
      out.push({ sellCurrency: f.sell, buyCurrency: f.buy, buyAmount: f.buyAmount });
      continue;
    }
    const rr = rate(f.buy, f.sell);
    if (rr === undefined) throw new Error(`No rate for ${f.buy}/${f.sell}`);
    const reverseSell = fxSellAmount(reverse.buyAmount, rr, f.buy, f.sell);
    if (f.buyAmount >= reverseSell) {
      if (f.buyAmount > reverseSell) {
        out.push({
          sellCurrency: f.sell,
          buyCurrency: f.buy,
          buyAmount: f.buyAmount - reverseSell,
        });
      }
    } else {
      const left = reverseSell - f.buyAmount;
      out.push({
        sellCurrency: f.buy,
        buyCurrency: f.sell,
        buyAmount: fxBuyAmount(left, rr, f.buy, f.sell),
      });
    }
  }
  return out.sort((a, b) =>
    pair(a.sellCurrency, a.buyCurrency).localeCompare(pair(b.sellCurrency, b.buyCurrency)),
  );
}

/** Total bought at market, per buy currency. */
export function boughtAtMarket(conversions: MarketConversion[]): Record<string, bigint> {
  const out: Record<string, bigint> = {};
  for (const c of conversions) out[c.buyCurrency] = (out[c.buyCurrency] ?? 0n) + c.buyAmount;
  return out;
}

/** Annualised volatility of a series of evenly spaced rates, from their log returns. */
export function realisedVolatility(rates: number[], samplesPerYear: number): number {
  const returns = rates.slice(1).map((r, i) => Math.log(r / (rates[i] as number)));
  if (returns.length < 2) return 0;
  const mean = returns.reduce((a, b) => a + b, 0) / returns.length;
  const variance = returns.reduce((a, r) => a + (r - mean) ** 2, 0) / (returns.length - 1);
  return Math.sqrt(variance * samplesPerYear);
}

export * from './margin.ts';
