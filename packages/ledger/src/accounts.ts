import type { Currency } from '@novate/core';

export interface AccountSpec {
  code: string;
  currency: Currency;
  /** credit = something the house owes (member funds); debit = something the house holds (cash). */
  normal: 'credit' | 'debit';
  noOverdraft: boolean;
}

/**
 * The chart of accounts. Every account belongs to a tenant; codes are stable and human-readable
 * so a balance can always be explained by listing the transfers that touched its code.
 */
export const Accounts = {
  /** Member funds held by the house and free to use. */
  memberAvailable: (memberId: string, currency: Currency): AccountSpec => ({
    code: `member:${memberId}:${currency}:available`,
    currency,
    normal: 'credit',
    noOverdraft: true,
  }),
  /**
   * A member's position within one clearing cycle. May go negative: a net debtor owes the house.
   * Per cycle, so two groups settling at once can never pay out each other's money.
   */
  cycleSettlement: (cycleId: string, memberId: string, currency: Currency): AccountSpec => ({
    code: `cycle:${cycleId}:${memberId}:${currency}:settlement`,
    currency,
    normal: 'credit',
    noOverdraft: false,
  }),
  /** What a member owes the house outside any cycle, such as a recalled deposit already spent. */
  memberDebt: (memberId: string, currency: Currency): AccountSpec => ({
    code: `member:${memberId}:${currency}:debt`,
    currency,
    normal: 'credit',
    noOverdraft: false,
  }),
  /** A member's contribution to the mutual default fund. Used only when a member defaults. */
  memberDefaultFund: (memberId: string, currency: Currency): AccountSpec => ({
    code: `member:${memberId}:${currency}:default_fund`,
    currency,
    normal: 'credit',
    noOverdraft: true,
  }),
  /** Collateral a member has posted against all of its open positions. */
  memberPortfolioMargin: (memberId: string, currency: Currency): AccountSpec => ({
    code: `member:${memberId}:${currency}:portfolio_margin`,
    currency,
    normal: 'credit',
    noOverdraft: true,
  }),
  /** Buyer funds locked against one deal. */
  dealEscrow: (dealId: string, currency: Currency): AccountSpec => ({
    code: `deal:${dealId}:${currency}:escrow`,
    currency,
    normal: 'credit',
    noOverdraft: true,
  }),
  /** Seller performance margin locked against one deal. */
  dealMargin: (dealId: string, currency: Currency): AccountSpec => ({
    code: `deal:${dealId}:${currency}:margin`,
    currency,
    normal: 'credit',
    noOverdraft: true,
  }),
  /** Cash the house holds on a settlement rail (an asset). */
  houseCash: (rail: string, currency: Currency): AccountSpec => ({
    code: `house:${rail}:${currency}:cash`,
    currency,
    normal: 'debit',
    noOverdraft: true,
  }),
  /** What a rail's own fees have taken from the house's money on it, which no member's cash covers. */
  houseFeesPaid: (rail: string, currency: Currency): AccountSpec => ({
    code: `house:${rail}:${currency}:fees_paid`,
    currency,
    normal: 'credit',
    noOverdraft: false,
  }),
  /** The house's cost of using its rails. */
  houseRailFees: (currency: Currency): AccountSpec => ({
    code: `house:${currency}:rail_fees`,
    currency,
    normal: 'debit',
    noOverdraft: false,
  }),
  /** Cash set aside for payouts already sent to a rail, so two cycles cannot spend it twice. */
  houseInFlight: (rail: string, currency: Currency): AccountSpec => ({
    code: `house:${rail}:${currency}:in_flight`,
    currency,
    normal: 'debit',
    noOverdraft: true,
  }),
  /** Novation account: the house as buyer to every seller and seller to every buyer. Nets to zero. */
  houseClearing: (currency: Currency): AccountSpec => ({
    code: `house:${currency}:clearing`,
    currency,
    normal: 'credit',
    noOverdraft: false,
  }),
  /** The house's position while currencies are being exchanged. Flat when a cycle closes. */
  houseFx: (currency: Currency): AccountSpec => ({
    code: `house:${currency}:fx`,
    currency,
    normal: 'credit',
    noOverdraft: false,
  }),
  /** Money that has reached a rail account and is not yet matched to a member. The house owes it. */
  houseSuspense: (currency: Currency): AccountSpec => ({
    code: `house:${currency}:suspense`,
    currency,
    normal: 'credit',
    noOverdraft: true,
  }),
  /** Losses the house absorbed covering a default as principal. */
  houseDefaultLoss: (currency: Currency): AccountSpec => ({
    code: `house:${currency}:default_loss`,
    currency,
    normal: 'debit',
    noOverdraft: false,
  }),
} as const;
