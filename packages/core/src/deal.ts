import { z } from 'zod';
import { Currency, MinorAmount } from './money.ts';

export const DealLine = z.object({
  sku: z.string(),
  description: z.string(),
  quantity: z.int().positive(),
  unitPrice: MinorAmount,
});
export type DealLine = z.infer<typeof DealLine>;

/** What two agents agreed. Free-form `attributes` lets platforms carry their own terms. */
export const DealTerms = z.object({
  category: z.string(),
  currency: Currency,
  lines: z.array(DealLine).min(1),
  incoterm: z.string().optional(),
  shipmentDate: z.iso.date().optional(),
  deliveryDate: z.iso.date().optional(),
  attributes: z.record(z.string(), z.unknown()).default({}),
});
export type DealTerms = z.infer<typeof DealTerms>;

export function dealAmount(terms: Pick<DealTerms, 'lines'>): bigint {
  return terms.lines.reduce((acc, l) => acc + l.unitPrice * BigInt(l.quantity), 0n);
}

export function dealQuantity(terms: Pick<DealTerms, 'lines'>): number {
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
]);
export type DealStatus = z.infer<typeof DealStatus>;

/** An agent's spending/selling authority, granted by the member that owns it. */
export const Mandate = z.object({
  roles: z.array(z.enum(['buy', 'sell'])).min(1),
  currencies: z.array(Currency).min(1),
  categories: z.array(z.string()).optional(),
  counterparties: z.array(z.string()).optional(),
  maxPerDeal: MinorAmount.optional(),
  monthlyLimit: MinorAmount.optional(),
});
export type Mandate = z.infer<typeof Mandate>;
