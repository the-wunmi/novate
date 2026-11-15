import { minorUnits } from '@novate/core';

const E8 = 100_000_000n;

/** A rate stored times 10^8 as a decimal string, without trailing zeros: 118846696n → "1.18846696". */
export function rateString(rateE8: bigint): string {
  const digits = rateE8.toString().padStart(9, '0');
  return `${digits.slice(0, -8)}.${digits.slice(-8)}`.replace(/\.?0+$/, '');
}

/** Which way a rate goes, in words: "1 GBP = 1.18846696 EUR". */
export const rateLabel = (sell: string, buy: string, rateE8: bigint) =>
  `1 ${sell} = ${rateString(rateE8)} ${buy}`;

/** The rate two amounts imply, as units of `buy` per 1 `sell`, times 10^8, rounded down. */
export function impliedRateE8(
  sellAmount: bigint,
  sellCurrency: string,
  buyAmount: bigint,
  buyCurrency: string,
): bigint | null {
  if (sellAmount <= 0n) return null;
  const numerator = buyAmount * E8 * 10n ** BigInt(minorUnits(sellCurrency));
  return numerator / (sellAmount * 10n ** BigInt(minorUnits(buyCurrency)));
}
