/**
 * How a member's exchange in a cycle reads back from the ledger. `applyExchanges` posts each
 * exchange as one batch: `fx_member_sell` legs out of the member's deal escrows in the currency it
 * sells, and one `fx_member_buy` leg into its cycle position in the currency it buys.
 */

export const MEMBER_FX_KINDS = ['fx_member_sell', 'fx_member_buy'] as const;

export const isMemberFx = (kind: string) => (MEMBER_FX_KINDS as readonly string[]).includes(kind);

export interface MemberFxLeg {
  batchId: string;
  kind: string;
  currency: string;
  amount: bigint;
}

export interface MemberFxExchange {
  batchId: string;
  sellCurrency: string;
  buyCurrency: string;
  sold: bigint;
  bought: bigint;
}

/** The exchanges the legs belong to, one per batch that holds both a sale and a purchase. */
export function memberFxExchanges(legs: MemberFxLeg[]): MemberFxExchange[] {
  const batches = new Map<string, MemberFxLeg[]>();
  for (const leg of legs) batches.set(leg.batchId, [...(batches.get(leg.batchId) ?? []), leg]);
  return [...batches].flatMap(([batchId, batch]) => {
    const sales = batch.filter((l) => l.kind === 'fx_member_sell');
    const purchase = batch.find((l) => l.kind === 'fx_member_buy');
    const sale = sales[0];
    if (!purchase || !sale) return [];
    return [
      {
        batchId,
        sellCurrency: sale.currency,
        buyCurrency: purchase.currency,
        sold: sales.reduce((acc, l) => acc + l.amount, 0n),
        bought: purchase.amount,
      },
    ];
  });
}

/** Every transfer into the house's FX position, from members' exchanges and its rail conversions. */
export const HOUSE_FX_IN = ['fx_member_sell', 'fx_buy', 'default_portfolio_margin_sell'] as const;
/** Every transfer out of it. What the two leave behind is what the house kept from rounding. */
export const HOUSE_FX_OUT = [
  'fx_member_buy',
  'fx_sell',
  'default_portfolio_margin_buy',
  'default_portfolio_margin_unsold',
] as const;
