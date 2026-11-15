import { z } from 'zod';
import { Currency, MinorAmount } from './money.ts';

export function validTimeZone(zone: string): boolean {
  try {
    new Intl.DateTimeFormat('en-US', { timeZone: zone });
    return true;
  } catch {
    return false;
  }
}

export const TimeZone = z
  .string()
  .min(1)
  .max(64)
  .refine(validTimeZone, { message: 'Not an IANA time zone' });

/**
 * The controls a house sets for itself, stored as JSON on the tenant. Parsing what is stored fills
 * in every default and turns amounts back into bigints.
 */
export const TenantSettings = z.object({
  /** Every person must set up two-step sign-in before doing anything. */
  requireTwoStep: z.boolean().default(true),
  /** IANA zone whose calendar day the books are signed off for. */
  timeZone: TimeZone.default('UTC'),
  /**
   * Per currency, minor units: above this a manual credit or write-off needs a second person. A
   * currency not listed has threshold 0, so every amount in it needs four eyes.
   */
  fourEyesAbove: z
    .record(
      Currency,
      MinorAmount.refine((v) => v >= 0n),
    )
    .default({}),
});
export type TenantSettings = z.output<typeof TenantSettings>;
/** What is stored: any part may be missing, and amounts are strings. */
export type StoredTenantSettings = z.input<typeof TenantSettings>;
