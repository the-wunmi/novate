import { type Db, deals, fxRateSamples } from '@novate/db';
import { realisedVolatility } from '@novate/fx';
import type { SignalProvider, SignalSubject } from '@novate/signals';
import { and, desc, eq, gte } from 'drizzle-orm';
import { deps } from './deps.ts';

const HOURLY_SAMPLES_PER_YEAR = 8_760;
const WINDOW_MS = 30 * 86_400_000;
/** Below two days of hourly samples the measurement is noise, so the table is used. */
const MIN_SAMPLES = 48;

/** Rough annualised volatility per currency, used until enough real samples exist. */
const STARTING_VOL_30D: Record<string, number> = {
  EUR: 0.06,
  GBP: 0.07,
  USD: 0.05,
  JPY: 0.09,
  NGN: 0.25,
};
const UNKNOWN_CURRENCY_VOL = 0.15;
/** Each sample is a rail call, and any member can invent a currency code. */
const MAX_SAMPLED_CURRENCIES = 30;

const baseFor = (currency: string) => (currency === 'USD' ? 'EUR' : 'USD');

/**
 * The `fx` signal: 30-day volatility of the deal's currency, measured from rates sampled off the
 * rail. Reports `measured: false` while it is still relying on the starting table.
 */
export class FxVolatilityProvider implements SignalProvider {
  readonly name = 'fx';
  readonly fallback = { vol30d: UNKNOWN_CURRENCY_VOL, measured: false };

  constructor(private readonly db: Db) {}

  resolve(subject: SignalSubject) {
    return currencyVolatility(this.db, subject.currency);
  }
}

export async function currencyVolatility(db: Db, currency: string) {
  const rows = await db
    .select({ rate: fxRateSamples.rateE8 })
    .from(fxRateSamples)
    .where(
      and(
        eq(fxRateSamples.sellCurrency, currency),
        eq(fxRateSamples.buyCurrency, baseFor(currency)),
        gte(fxRateSamples.sampledAt, new Date(Date.now() - WINDOW_MS)),
      ),
    )
    .orderBy(desc(fxRateSamples.sampledAt));
  if (rows.length < MIN_SAMPLES) {
    return { vol30d: STARTING_VOL_30D[currency] ?? UNKNOWN_CURRENCY_VOL, measured: false };
  }
  const rates = rows.map((r) => Number(r.rate)).reverse();
  return { vol30d: realisedVolatility(rates, HOURLY_SAMPLES_PER_YEAR), measured: true };
}

/** Record the current rate for every currency being dealt in. A failed quote skips that sample. */
export async function sampleFxRates(): Promise<number> {
  const { db, rails, fxSampleRail } = deps();
  if (!fxSampleRail) return 0;
  const rail = rails.get(fxSampleRail);
  const inUse = await db
    .selectDistinct({ currency: deals.currency })
    .from(deals)
    .limit(MAX_SAMPLED_CURRENCIES);
  let sampled = 0;
  for (const { currency } of inUse) {
    const buyCurrency = baseFor(currency);
    const quote = await rail.quote(currency, buyCurrency).catch((err: unknown) => {
      console.warn(`No ${currency}/${buyCurrency} rate sampled:`, (err as Error).message);
      return null;
    });
    if (!quote) continue;
    await db
      .insert(fxRateSamples)
      .values({ sellCurrency: currency, buyCurrency, rateE8: quote.rateE8 });
    sampled++;
  }
  return sampled;
}
