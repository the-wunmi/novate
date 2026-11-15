import { absBig, applyBps, type Currency, fxBuyAmount, mulDivUp } from '@novate/core';

/** One open deal from one member's side. Positive is money to receive, negative is money to pay. */
export interface OpenExposure {
  currency: Currency;
  amount: bigint;
  /** Home currency per unit of `currency` when the position opened, ×10^8. */
  bookedRateE8: bigint;
}

export interface MarginParams {
  baseBps: number;
  stressMultiple: number;
  horizonDays: number;
  /** How much of a receivable in one currency may offset a payable in another. */
  crossOffsetBps: number;
}

export interface MarginInput {
  home: Currency;
  exposures: OpenExposure[];
  /** Home currency per unit of the given currency now, ×10^8. */
  rate: (currency: Currency) => bigint;
  /** Annualised volatility of the given currency. */
  volatility: (currency: Currency) => number;
}

export interface MarginRequirement {
  required: bigint;
  /** Net payables after offsets, in the home currency. */
  exposure: bigint;
  base: bigint;
  stress: bigint;
  /** Unrealised loss since the positions opened. */
  variation: bigint;
}

const E8 = 100_000_000n;

/** Value a signed amount in the home currency, rounding against the member. */
function valueAt(amount: bigint, rateE8: bigint, currency: Currency, home: Currency): bigint {
  if (currency === home) return amount;
  const magnitude = fxBuyAmount(absBig(amount), rateE8, currency, home);
  return amount < 0n ? -(magnitude + 1n) : magnitude;
}

/**
 * What a member must have posted against its open positions. Pure. Positions net within a currency
 * first, and receivables offset payables across currencies at a haircut. The house's risk is a
 * member failing to pay, so stress applies to net payables in foreign currencies only.
 */
export function marginRequirement(input: MarginInput, params: MarginParams): MarginRequirement {
  const { home, exposures, rate, volatility } = input;
  const byCurrency = Map.groupBy(exposures, (e) => e.currency);

  let payables = 0n;
  let receivables = 0n;
  let stress = 0n;
  let unrealised = 0n;
  for (const [currency, list] of byCurrency) {
    const net = list.reduce((acc, e) => acc + e.amount, 0n);
    const now = valueAt(net, currency === home ? E8 : rate(currency), currency, home);
    if (now < 0n) payables += -now;
    else receivables += now;

    if (currency !== home && now < 0n) {
      const shockBps = Math.ceil(
        volatility(currency) * Math.sqrt(params.horizonDays / 365) * params.stressMultiple * 10_000,
      );
      stress += mulDivUp(-now, BigInt(shockBps), 10_000n);
    }
    const booked = list.reduce(
      (acc, e) => acc + valueAt(e.amount, e.bookedRateE8, currency, home),
      0n,
    );
    unrealised += booked - now;
  }

  const offset = applyBps(receivables, params.crossOffsetBps);
  const exposure = payables > offset ? payables - offset : 0n;
  const base = mulDivUp(exposure, BigInt(params.baseBps), 10_000n);
  const variation = unrealised > 0n && exposure > 0n ? unrealised : 0n;
  return { required: base + stress + variation, exposure, base, stress, variation };
}
