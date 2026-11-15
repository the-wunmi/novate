import type { Currency } from '@novate/core';
import type { LedgerAccountKind } from '@novate/db';

export type { LedgerAccountKind as AccountKind } from '@novate/db';

/** Who an account belongs to. Written once, when the account is created, and read by queries. */
export interface AccountOwner {
  memberId?: string;
  dealId?: string;
  cycleId?: string;
  rail?: string;
}

export interface AccountSpec extends AccountOwner {
  /** Unique per tenant. */
  code: string;
  kind: LedgerAccountKind;
  currency: Currency;
  /** credit = something the house owes (member funds); debit = something the house holds (cash). */
  normal: 'credit' | 'debit';
  noOverdraft: boolean;
}

/**
 * The chart of accounts. Every account belongs to a tenant; codes are stable and human-readable
 * so a balance can always be explained by listing the transfers that touched its code. Readers find
 * accounts by kind and owner, never by taking a code apart.
 */
export const Accounts = {
  /** Member funds held by the house and free to use. */
  memberAvailable: (memberId: string, currency: Currency): AccountSpec => ({
    code: `member:${memberId}:${currency}:available`,
    kind: 'available',
    memberId,
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
    kind: 'settlement',
    cycleId,
    memberId,
    currency,
    normal: 'credit',
    noOverdraft: false,
  }),
  /** What a member owes the house outside any cycle, such as a recalled deposit already spent. */
  memberDebt: (memberId: string, currency: Currency): AccountSpec => ({
    code: `member:${memberId}:${currency}:debt`,
    kind: 'debt',
    memberId,
    currency,
    normal: 'credit',
    noOverdraft: false,
  }),
  /** A member's contribution to the mutual default fund. Used only when a member defaults. */
  memberDefaultFund: (memberId: string, currency: Currency): AccountSpec => ({
    code: `member:${memberId}:${currency}:default_fund`,
    kind: 'default_fund',
    memberId,
    currency,
    normal: 'credit',
    noOverdraft: true,
  }),
  /** Collateral a member has posted against all of its open positions. */
  memberPortfolioMargin: (memberId: string, currency: Currency): AccountSpec => ({
    code: `member:${memberId}:${currency}:portfolio_margin`,
    kind: 'portfolio_margin',
    memberId,
    currency,
    normal: 'credit',
    noOverdraft: true,
  }),
  /** Buyer funds locked against one deal. */
  dealEscrow: (dealId: string, currency: Currency): AccountSpec => ({
    code: `deal:${dealId}:${currency}:escrow`,
    kind: 'escrow',
    dealId,
    currency,
    normal: 'credit',
    noOverdraft: true,
  }),
  /** Seller performance margin locked against one deal. */
  dealMargin: (dealId: string, currency: Currency): AccountSpec => ({
    code: `deal:${dealId}:${currency}:margin`,
    kind: 'margin',
    dealId,
    currency,
    normal: 'credit',
    noOverdraft: true,
  }),
  /** Cash the house holds on a settlement rail (an asset). */
  houseCash: (rail: string, currency: Currency): AccountSpec => ({
    code: `house:${rail}:${currency}:cash`,
    kind: 'cash',
    rail,
    currency,
    normal: 'debit',
    noOverdraft: true,
  }),
  /** What a rail's own fees have taken from the house's money on it, which no member's cash covers. */
  houseFeesPaid: (rail: string, currency: Currency): AccountSpec => ({
    code: `house:${rail}:${currency}:fees_paid`,
    kind: 'fees_paid',
    rail,
    currency,
    normal: 'credit',
    noOverdraft: false,
  }),
  /** The house's cost of using its rails. */
  houseRailFees: (currency: Currency): AccountSpec => ({
    code: `house:${currency}:rail_fees`,
    kind: 'rail_fees',
    currency,
    normal: 'debit',
    noOverdraft: false,
  }),
  /** The house's share of program fees on settled deals. */
  houseFeeRevenue: (currency: Currency): AccountSpec => ({
    code: `house:${currency}:fee_revenue`,
    kind: 'house_fee_revenue',
    currency,
    normal: 'credit',
    noOverdraft: false,
  }),
  /** The platform's share of program fees, which the house holds for the tenant's platform. */
  platformFeeRevenue: (currency: Currency): AccountSpec => ({
    code: `platform:${currency}:fee_revenue`,
    kind: 'platform_fee_revenue',
    currency,
    normal: 'credit',
    noOverdraft: false,
  }),
  /** Cash set aside for payouts already sent to a rail, so two cycles cannot spend it twice. */
  houseInFlight: (rail: string, currency: Currency): AccountSpec => ({
    code: `house:${rail}:${currency}:in_flight`,
    kind: 'in_flight',
    rail,
    currency,
    normal: 'debit',
    noOverdraft: true,
  }),
  /** Novation account: the house as buyer to every seller and seller to every buyer. Nets to zero. */
  houseClearing: (currency: Currency): AccountSpec => ({
    code: `house:${currency}:clearing`,
    kind: 'clearing',
    currency,
    normal: 'credit',
    noOverdraft: false,
  }),
  /** The house's position while currencies are being exchanged. Flat when a cycle closes. */
  houseFx: (currency: Currency): AccountSpec => ({
    code: `house:${currency}:fx`,
    kind: 'fx',
    currency,
    normal: 'credit',
    noOverdraft: false,
  }),
  /** Money that has reached a rail account and is not yet matched to a member. The house owes it. */
  houseSuspense: (currency: Currency): AccountSpec => ({
    code: `house:${currency}:suspense`,
    kind: 'suspense',
    currency,
    normal: 'credit',
    noOverdraft: true,
  }),
  /** Losses the house absorbed covering a default as principal. */
  houseDefaultLoss: (currency: Currency): AccountSpec => ({
    code: `house:${currency}:default_loss`,
    kind: 'default_loss',
    currency,
    normal: 'debit',
    noOverdraft: false,
  }),
} as const;

/** A member's own accounts, outside any deal or cycle. */
export const MEMBER_ACCOUNT_KINDS = [
  'available',
  'debt',
  'default_fund',
  'portfolio_margin',
] as const satisfies readonly LedgerAccountKind[];

/**
 * What program fees post as: the platform's or the house's share, collected at settlement or
 * booked as the member's debt because it could not pay then.
 */
export const PROGRAM_FEE_KINDS = [
  'platform_fee',
  'house_fee',
  'platform_fee_debt',
  'house_fee_debt',
] as const;
export type ProgramFeeKind = (typeof PROGRAM_FEE_KINDS)[number];

export const programFeeKind = (share: 'platform' | 'house', owed: boolean): ProgramFeeKind =>
  `${share}_fee${owed ? '_debt' : ''}`;
