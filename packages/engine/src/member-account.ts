import { DomainError, parseInput, TERMINAL_DEAL_STATUSES } from '@novate/core';
import { cycles, deals, marginCalls, settlementInstructions, type Tx, tenants } from '@novate/db';
import { type DepositDetails, maskTail, RefKeys, readDepositDetails } from '@novate/rails';
import { and, count, eq, notInArray, or } from 'drizzle-orm';
import { z } from 'zod';
import { paidAtOf } from './cycle-views.ts';
import { railRefusal } from './deal-policy.ts';
import { deps } from './deps.ts';
import { Cursor, keyset, newestFirst, pageOf } from './page.ts';
import { heldRails } from './recon-breaks.ts';
import { latestAttempt, type MemberRow, memberInTenant } from './repo.ts';

export interface DepositAccount {
  rail: string;
  /** The rail's id for the account, which deposits are matched on. */
  reference: string;
  /**
   * How to pay in, as the rail recorded it when it opened the account. Null for an account set by
   * hand, such as a wallet address, which is all a payer needs.
   */
  details: DepositDetails | null;
}

export interface PayoutAccount {
  rail: string;
  currency: string | null;
  /** Masked: the bank and the last four of the account, or of the rail's id for it. */
  label: string;
}

/** Rails this tenant may use, in the order the server registered them. */
const usableRails = (tenantId: string) =>
  deps()
    .rails.all()
    .map((r) => r.name)
    .filter((name) => railRefusal(tenantId, name) === null);

export function depositAccountsOf(tenantId: string, member: MemberRow): DepositAccount[] {
  const refs = member.railRefs;
  return usableRails(tenantId).flatMap((rail) => {
    const reference = refs[RefKeys.depositAccount(rail)];
    if (!reference) return [];
    const stored = refs[RefKeys.depositDetails(rail)];
    return [{ rail, reference, details: stored ? readDepositDetails(stored) : null }];
  });
}

/** Where a member's payouts go: the first usable rail with a payee or an account for it. */
export function payoutAccountOf(tenantId: string, member: MemberRow): PayoutAccount | null {
  const refs = member.railRefs;
  for (const rail of usableRails(tenantId)) {
    const target = refs[RefKeys.beneficiary(rail)] ?? refs[RefKeys.account(rail)];
    if (!target) continue;
    const stored = refs[RefKeys.payoutLabel(rail)];
    const kind = refs[RefKeys.beneficiary(rail)] ? 'Payee' : 'Account';
    return {
      rail,
      currency: refs[RefKeys.payoutCurrency(rail)] ?? null,
      label: stored ?? `${kind} ${maskTail(target)}`,
    };
  }
  return null;
}

/** Whether the member can both be paid in and be paid out. */
export const isProvisioned = (tenantId: string, member: MemberRow) =>
  depositAccountsOf(tenantId, member).length > 0 && payoutAccountOf(tenantId, member) !== null;

/** Why a withdrawal asked for now would be refused for something other than its amount. */
export type WithdrawalHold = 'settlement' | 'rail' | 'suspended' | 'close_only' | 'margin_call';

/**
 * What stops this member's money moving now: the tenant's stop, any rail it can use that has open
 * reconciliation differences, and why a withdrawal would be refused, if it would: either of those,
 * the member's own status, or an open margin call.
 */
async function memberHolds(db: Tx, tenantId: string, member: MemberRow, calls: unknown[]) {
  const [[tenant], held] = await Promise.all([
    db
      .select({ at: tenants.settlementHaltedAt, reason: tenants.settlementHaltReason })
      .from(tenants)
      .where(eq(tenants.id, tenantId)),
    heldRails(db, tenantId),
  ]);
  const usable = usableRails(tenantId);
  const rails = held.filter((h) => usable.includes(h.rail));
  const settlement = tenant?.at ? { since: tenant.at, reason: tenant.reason ?? null } : null;
  const payoutRail = payoutAccountOf(tenantId, member)?.rail;
  const railHeld = payoutRail ? rails.some((r) => r.rail === payoutRail) : rails.length > 0;
  const withdrawals: WithdrawalHold | null = settlement
    ? 'settlement'
    : railHeld
      ? 'rail'
      : member.status !== 'active'
        ? member.status
        : calls.length
          ? 'margin_call'
          : null;
  return { settlement, rails, withdrawals };
}

/** What a member's treasurer needs to pay in and to know where its money goes. */
export async function memberAccount(tenantId: string, memberId: string) {
  const { db } = deps();
  const member = await memberInTenant(db, tenantId, memberId);
  const payoutAccount = payoutAccountOf(tenantId, member);
  const [open] = await db
    .select({ n: count() })
    .from(deals)
    .where(
      and(
        eq(deals.tenantId, tenantId),
        or(eq(deals.buyerMemberId, member.id), eq(deals.sellerMemberId, member.id)),
        notInArray(deals.status, [...TERMINAL_DEAL_STATUSES]),
      ),
    );
  const calls = await db
    .select({
      id: marginCalls.id,
      currency: marginCalls.currency,
      amount: marginCalls.amount,
      dueAt: marginCalls.dueAt,
      extensions: marginCalls.extensions,
      createdAt: marginCalls.createdAt,
    })
    .from(marginCalls)
    .where(and(eq(marginCalls.memberId, member.id), eq(marginCalls.status, 'open')));
  return {
    id: member.id,
    name: member.name,
    legalName: member.legalName,
    country: member.country,
    contactEmail: member.contactEmail,
    homeCurrency: member.homeCurrency,
    status: member.status,
    depositAccounts: depositAccountsOf(tenantId, member),
    payoutAccount,
    defaultWithdrawalRail: payoutAccount?.rail ?? null,
    holds: await memberHolds(db as unknown as Tx, tenantId, member, calls),
    marginCalls: calls,
    /** Above these, per currency in minor units, a withdrawal waits for a second member user. */
    withdrawalFourEyesAbove: member.withdrawalFourEyesAbove,
    /** Deals it is a party to that have not reached an end. */
    openDeals: open?.n ?? 0,
  };
}

/** The rail a withdrawal goes over when the member does not name one. */
export async function defaultWithdrawalRail(tenantId: string, memberId: string): Promise<string> {
  const member = await memberInTenant(deps().db, tenantId, memberId);
  const payout = payoutAccountOf(tenantId, member);
  if (!payout) {
    throw new DomainError(
      'no_payout_account',
      'No payout account is on record for this member; name a rail',
    );
  }
  return payout.rail;
}

export const WithdrawalsQuery = z.object({
  /** The previous page's `next`. */
  before: Cursor.optional(),
  limit: z.coerce.number().int().min(1).max(200).default(50),
});

/** A member's withdrawals, newest first, each as its latest payment attempt stands. */
export async function memberWithdrawals(
  tenantId: string,
  memberId: string,
  input: z.input<typeof WithdrawalsQuery> = {},
) {
  const { before, limit } = parseInput(WithdrawalsQuery, input);
  const { db } = deps();
  await memberInTenant(db, tenantId, memberId);
  const rows = await db
    .select({ at: cycles.createdAt, latest: settlementInstructions })
    .from(cycles)
    .innerJoin(settlementInstructions, eq(settlementInstructions.cycleId, cycles.id))
    .where(
      and(
        eq(cycles.tenantId, tenantId),
        eq(cycles.kind, 'withdrawal'),
        eq(settlementInstructions.memberId, memberId),
        latestAttempt(db),
        keyset(cycles.createdAt, cycles.id, tenantId, before),
      ),
    )
    .orderBy(...newestFirst(cycles.createdAt, cycles.id))
    .limit(limit + 1);
  const paidAt = await paidAtOf(
    db,
    rows.map((r) => r.latest.id),
  );
  const withdrawals = rows.map(({ at, latest }) => ({
    id: latest.cycleId,
    at,
    currency: latest.currency,
    amount: latest.amount,
    rail: latest.rail,
    status: latest.status,
    externalRef: latest.externalRef,
    failureReason: latest.failureReason,
    /** When the rail first confirmed it, from the instruction's history. */
    paidAt: paidAt.get(latest.id) ?? null,
    /** It could not be sent, so the money is back in the member's wallet. */
    returnedToWallet: latest.returnedToWalletAt !== null,
  }));
  return pageOf(withdrawals, limit, (w) => w.id);
}
