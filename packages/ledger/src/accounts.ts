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
  /** Member's position within a clearing cycle. May go negative: a net debtor owes the house. */
  memberSettlement: (memberId: string, currency: Currency): AccountSpec => ({
    code: `member:${memberId}:${currency}:settlement`,
    currency,
    normal: 'credit',
    noOverdraft: false,
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
  /** Novation account: the house as buyer to every seller and seller to every buyer. Nets to zero. */
  houseClearing: (currency: Currency): AccountSpec => ({
    code: `house:${currency}:clearing`,
    currency,
    normal: 'credit',
    noOverdraft: false,
  }),
  houseFees: (currency: Currency): AccountSpec => ({
    code: `house:${currency}:fees`,
    currency,
    normal: 'credit',
    noOverdraft: true,
  }),
} as const;
