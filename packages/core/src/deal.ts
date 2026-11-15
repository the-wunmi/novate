import { z } from 'zod';
import { Currency, MAX_MINOR, MinorAmount } from './money.ts';

export const DealLine = z.object({
  sku: z.string().optional(),
  description: z.string(),
  quantity: z.int().positive().default(1),
  unitPrice: MinorAmount.refine((v) => v > 0n, { message: 'Unit price must be positive' }),
});
export type DealLine = z.infer<typeof DealLine>;

export const DealShape = z.enum(['goods', 'service', 'payment']);
export type DealShape = z.infer<typeof DealShape>;

/** Another payment created by the deal, such as a platform fee, a share or a commission. */
export const DealLeg = z.object({
  id: z
    .string()
    .regex(/^[a-z0-9_-]+$/)
    .refine((v) => v !== 'principal'),
  payer: z.enum(['buyer', 'seller']),
  payeeMemberId: z.string().uuid(),
  /** Share of the amount that ends up released, in basis points. */
  bps: z.int().min(1).max(10_000),
});
export type DealLeg = z.infer<typeof DealLeg>;

/** What two agents agreed. Free-form `attributes` lets platforms carry their own terms. */
export const DealTerms = z
  .object({
    shape: DealShape.default('goods'),
    category: z.string(),
    currency: Currency,
    lines: z.array(DealLine).min(1),
    legs: z.array(DealLeg).default([]),
    incoterm: z.string().optional(),
    shipmentDate: z.iso.date().optional(),
    deliveryDate: z.iso.date().optional(),
    attributes: z.record(z.string(), z.unknown()).default({}),
  })
  .refine((t) => dealAmount(t) <= MAX_MINOR, { message: 'Deal is too large' });
export type DealTerms = z.infer<typeof DealTerms>;
/** Terms as stored: amounts as strings and defaults unfilled until parsed. */
export type StoredDealTerms = z.input<typeof DealTerms>;

export function dealAmount(terms: { lines: { quantity: number; unitPrice: bigint }[] }): bigint {
  return terms.lines.reduce((acc, l) => acc + l.unitPrice * BigInt(l.quantity), 0n);
}

export function dealQuantity(terms: { lines: { quantity: number }[] }): number {
  return terms.lines.reduce((acc, l) => acc + l.quantity, 0);
}

export const DealStatus = z.enum([
  'submitted',
  'authorised',
  'frozen',
  'awaiting_funding',
  'awaiting_conditions',
  'held',
  'eligible',
  'settling',
  'settled',
  'cancelled',
  'rejected',
  'refunded',
  'exception',
]);
export type DealStatus = z.infer<typeof DealStatus>;

/** A deal in one of these states holds nothing and will not change again. */
export const TERMINAL_DEAL_STATUSES = ['settled', 'cancelled', 'rejected', 'refunded'] as const;

/** A document as received, before it has been read. */
export type DocumentContent =
  | { kind: 'pdf'; base64: string }
  | { kind: 'image'; mediaType: 'image/png' | 'image/jpeg' | 'image/webp'; base64: string }
  | { kind: 'text'; text: string };

/** Limits in one currency's minor units. */
export const CurrencyLimits = z.object({
  maxPerDeal: MinorAmount.optional(),
  monthlyLimit: MinorAmount.optional(),
});
export type CurrencyLimits = z.infer<typeof CurrencyLimits>;

/**
 * An agent's spending/selling authority, granted by the member that owns it. `limits` names the
 * currencies the agent may deal in, each with its limits in that currency's minor units; a deal in
 * any other currency is refused.
 */
export const Mandate = z.object({
  roles: z.array(z.enum(['buy', 'sell'])).min(1),
  limits: z
    .record(Currency, CurrencyLimits)
    .refine((l) => Object.keys(l).length > 0, 'Name at least one currency'),
  categories: z.array(z.string()).optional(),
  counterparties: z.array(z.string()).optional(),
});

/** The limits that apply to a deal in `currency`, or null when the mandate does not allow it. */
export function mandateLimits(m: Mandate, currency: Currency): CurrencyLimits | null {
  return m.limits[currency] ?? null;
}
export type Mandate = z.infer<typeof Mandate>;
/** A mandate as stored: amounts as strings until parsed. */
export type StoredMandate = z.input<typeof Mandate>;

/** What a fact records. A document's reading puts what it says in `fields` and its problems in `issues`. */
export interface FactData {
  fields?: Record<string, unknown>;
  issues?: { code: string; message: string }[];
  [key: string]: unknown;
}
