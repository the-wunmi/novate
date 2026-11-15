// What every page of the member portal shares: the member's account, and how it sits in a deal.
import { useTenant } from '../api.ts';
import type { Deal, Me, MemberAccount } from '../types.ts';
import { shortId } from '../ui.tsx';

/** The member's own account, kept live: balances held, open deals and what stops its money. */
export const useMyAccount = (me: Me) =>
  useTenant<MemberAccount>(me.tenantId, `/members/${me.memberId}/account`, { live: true });

export const role = (d: Pick<Deal, 'buyerMemberId'>, memberId: string) =>
  d.buyerMemberId === memberId ? 'buyer' : 'seller';
export const counterparty = (
  d: Pick<Deal, 'buyerMemberId' | 'sellerMemberId'> & {
    buyerName: string | null;
    sellerName: string | null;
  },
  memberId: string,
) =>
  (d.buyerMemberId === memberId ? d.sellerName : d.buyerName) ??
  shortId('MB', d.buyerMemberId === memberId ? d.sellerMemberId : d.buyerMemberId);
