import { type Currency, fxBuyAmount, minBig } from '@novate/core';
import { cardPayments, cycles, deals, marginCalls, members, obligations } from '@novate/db';
import { MEMBER_ACCOUNT_KINDS } from '@novate/ledger';
import { and, eq, inArray, isNull, sql } from 'drizzle-orm';
import { deps } from './deps.ts';
import { depositAccountsOf, isProvisioned, payoutAccountOf } from './member-account.ts';
import { escrowCurrency } from './repo.ts';

/** Obligations not yet settled: accepted, released, or in a cycle that has not closed. */
const OPEN_OBLIGATIONS = ['pending', 'eligible', 'netted'] as const;

interface CurrencyExposure {
  currency: string;
  available: bigint;
  /** Escrow of deals it buys and margin of deals it sells. */
  locked: bigint;
  lockedByDeal: { dealId: string; kind: 'escrow' | 'margin'; amount: bigint }[];
  portfolioMargin: {
    posted: bigint;
    /** As of the last assessment: what is posted plus any open call in this currency. */
    required: bigint;
  };
  defaultFund: bigint;
  /** Negative: what the member owes the house outside any cycle. */
  debt: bigint;
  /** Obligations not yet settled. Positive net means it will receive. */
  openObligations: { payable: bigint; receivable: bigint; net: bigint };
}

/**
 * Where each member stands with the house, per currency, from the ledger as it is now: free money,
 * money locked in deals, collateral, open margin calls and what it will pay or receive.
 */
export async function exposure(tenantId: string) {
  const { db, ledger } = deps();
  const [memberRows, memberAccounts, dealAccounts, cycleAccounts, dealRows, open, calls, cards] =
    await Promise.all([
      db.select().from(members).where(eq(members.tenantId, tenantId)),
      ledger.balances(db, tenantId, { kinds: MEMBER_ACCOUNT_KINDS }),
      ledger.balances(db, tenantId, { kinds: ['escrow', 'margin'] }),
      ledger.balances(db, tenantId, { kinds: ['settlement'] }),
      db
        .select({
          id: deals.id,
          buyer: deals.buyerMemberId,
          seller: deals.sellerMemberId,
          currency: deals.currency,
          fundingCurrency: deals.fundingCurrency,
          lockRates: sql<Record<string, string> | null>`${deals.policySnapshot}->'lockRates'`,
        })
        .from(deals)
        .where(eq(deals.tenantId, tenantId)),
      db
        .select({
          dealId: obligations.dealId,
          leg: obligations.leg,
          payer: obligations.payerMemberId,
          payee: obligations.payeeMemberId,
          currency: obligations.currency,
          amount: obligations.amount,
          status: obligations.status,
          cycleId: obligations.cycleId,
          cycleStatus: cycles.status,
        })
        .from(obligations)
        .leftJoin(cycles, eq(cycles.id, obligations.cycleId))
        .where(
          and(
            eq(obligations.tenantId, tenantId),
            inArray(obligations.status, [...OPEN_OBLIGATIONS]),
          ),
        ),
      db
        .select()
        .from(marginCalls)
        .where(and(eq(marginCalls.tenantId, tenantId), eq(marginCalls.status, 'open'))),
      db
        .select({
          currency: cardPayments.currency,
          amount: sql<string>`sum(${cardPayments.amount})`,
        })
        .from(cardPayments)
        .where(
          and(
            eq(cardPayments.tenantId, tenantId),
            eq(cardPayments.status, 'succeeded'),
            isNull(cardPayments.settledAt),
          ),
        )
        .groupBy(cardPayments.currency),
    ]);

  const book = new Map<string, Map<string, CurrencyExposure>>();
  const at = (memberId: string, currency: string): CurrencyExposure => {
    const mine = book.get(memberId) ?? new Map<string, CurrencyExposure>();
    book.set(memberId, mine);
    const found = mine.get(currency) ?? {
      currency,
      available: 0n,
      locked: 0n,
      lockedByDeal: [],
      portfolioMargin: { posted: 0n, required: 0n },
      defaultFund: 0n,
      debt: 0n,
      openObligations: { payable: 0n, receivable: 0n, net: 0n },
    };
    mine.set(currency, found);
    return found;
  };

  for (const a of memberAccounts) {
    if (a.balance === 0n) continue;
    const e = at(a.memberId as string, a.currency);
    if (a.kind === 'available') e.available = a.balance;
    if (a.kind === 'portfolio_margin') e.portfolioMargin.posted = a.balance;
    if (a.kind === 'default_fund') e.defaultFund = a.balance;
    if (a.kind === 'debt') e.debt = a.balance;
  }
  const parties = new Map(dealRows.map((d) => [d.id, d]));
  for (const a of dealAccounts) {
    const { dealId, kind } = a;
    const deal = dealId ? parties.get(dealId) : undefined;
    if (!deal || !dealId || a.balance === 0n || (kind !== 'escrow' && kind !== 'margin')) continue;
    const e = at(kind === 'escrow' ? deal.buyer : deal.seller, a.currency);
    e.locked += a.balance;
    e.lockedByDeal.push({ dealId, kind, amount: a.balance });
  }
  for (const o of open) {
    at(o.payer, o.currency).openObligations.payable += o.amount;
    at(o.payee, o.currency).openObligations.receivable += o.amount;
  }
  for (const call of calls) at(call.memberId, call.currency);
  for (const mine of book.values()) {
    for (const e of mine.values()) {
      e.openObligations.net = e.openObligations.receivable - e.openObligations.payable;
    }
  }
  for (const call of calls) {
    const e = at(call.memberId, call.currency);
    e.portfolioMargin.required = e.portfolioMargin.posted + call.amount;
  }
  for (const mine of book.values()) {
    for (const e of mine.values()) {
      if (e.portfolioMargin.required === 0n) e.portfolioMargin.required = e.portfolioMargin.posted;
    }
  }

  const escrow = new Map(
    dealAccounts.flatMap((a) => (a.kind === 'escrow' && a.dealId ? [[a.dealId, a.balance]] : [])),
  );
  // What a cycle has already collected from a payer before it commits, escrow it converted included.
  const settling = new Set(
    open.flatMap((o) =>
      o.status === 'netted' && o.cycleStatus === 'settling' && o.cycleId ? [o.cycleId] : [],
    ),
  );
  const collected = new Map<string, bigint>();
  for (const a of cycleAccounts) {
    if (!a.cycleId || !settling.has(a.cycleId) || a.balance <= 0n) continue;
    const key = `${a.memberId}:${a.currency}`;
    collected.set(key, (collected.get(key) ?? 0n) + a.balance);
  }
  const risk = houseRisk({
    book,
    names: new Map(memberRows.map((m) => [m.id, m.name])),
    // The house pays nothing on an obligation until its deal releases it, so a pending one, funded
    // or not, puts nothing at risk. Once a cycle commits, the payer's money is already in.
    open: open.filter((o) => o.status !== 'pending'),
    covered: (o) => {
      if (o.cycleStatus === 'committed') return o.amount;
      const deal = parties.get(o.dealId);
      const held = escrow.get(o.dealId) ?? 0n;
      // Only the deal itself is locked up front, so only its principal leg is backed by escrow.
      if (!deal || o.leg !== 'principal' || held === 0n) return 0n;
      const currency = escrowCurrency(deal);
      if (currency === o.currency) return minBig(held, o.amount);
      const rate = deal.lockRates?.[currency];
      return rate
        ? minBig(
            fxBuyAmount(held, BigInt(rate), currency as Currency, o.currency as Currency),
            o.amount,
          )
        : 0n;
    },
    collected,
    calls,
    cards: cards.map((c) => ({ currency: c.currency, amount: BigInt(c.amount) })),
  });

  return {
    risk,
    members: memberRows.map((m) => {
      const provisioned = isProvisioned(tenantId, m);
      return {
        memberId: m.id,
        name: m.name,
        legalName: m.legalName,
        country: m.country,
        contactEmail: m.contactEmail,
        status: m.status,
        homeCurrency: m.homeCurrency,
        /** Has a deposit account and a payout account on a rail this tenant uses. */
        provisioned,
        /** When its rail accounts were last set, for a provisioned member. */
        accountsOpenedAt: provisioned ? m.railRefsChangedAt : null,
        /** Waiting for accounts since it was added; null once it has them. */
        waitingSince: provisioned ? null : m.createdAt,
        depositAccounts: depositAccountsOf(tenantId, m),
        payoutAccount: payoutAccountOf(tenantId, m),
        currencies: [...(book.get(m.id)?.values() ?? [])],
        marginCalls: calls
          .filter((c) => c.memberId === m.id)
          .map((c) => ({ id: c.id, currency: c.currency, amount: c.amount, dueAt: c.dueAt })),
      };
    }),
  };
}

interface OpenObligation {
  dealId: string;
  leg: string;
  payer: string;
  payee: string;
  currency: string;
  amount: bigint;
  cycleStatus: string | null;
}

/**
 * The house's own risk per currency: what members owe in open obligations, the part of it nothing
 * the house holds secures (each member's released payables less the escrow behind them, what a
 * cycle has already collected from it, what it is owed and its posted portfolio margin), the member that would cost most if it failed, what the default fund
 * holds against that, open margin calls, and card money credited to members that the card network
 * has not yet paid over, which the house is fronting.
 */
function houseRisk(input: {
  book: Map<string, Map<string, CurrencyExposure>>;
  names: Map<string, string>;
  covered: (o: OpenObligation) => bigint;
  /** Obligations the house is bound to pay. */
  open: OpenObligation[];
  collected: Map<string, bigint>;
  calls: { currency: string; amount: bigint }[];
  cards: { currency: string; amount: bigint }[];
}) {
  const uncovered = new Map<string, bigint>();
  const owed = new Map<string, bigint>();
  for (const o of input.open) {
    const key = `${o.payer}:${o.currency}`;
    uncovered.set(key, (uncovered.get(key) ?? 0n) + o.amount - input.covered(o));
    const payee = `${o.payee}:${o.currency}`;
    owed.set(payee, (owed.get(payee) ?? 0n) + o.amount);
  }
  type Row = {
    currency: string;
    payable: bigint;
    unsecured: bigint;
    largest: { memberId: string; name: string; amount: bigint } | null;
    defaultFund: bigint;
    marginCalls: { count: number; amount: bigint };
    cardsFronted: bigint;
  };
  const rows = new Map<string, Row>();
  const row = (currency: string) => {
    const found = rows.get(currency) ?? {
      currency,
      payable: 0n,
      unsecured: 0n,
      largest: null,
      defaultFund: 0n,
      marginCalls: { count: 0, amount: 0n },
      cardsFronted: 0n,
    };
    rows.set(currency, found);
    return found;
  };
  for (const [memberId, mine] of input.book) {
    for (const e of mine.values()) {
      const r = row(e.currency);
      r.payable += e.openObligations.payable;
      r.defaultFund += e.defaultFund;
      const key = `${memberId}:${e.currency}`;
      const unsecured =
        (uncovered.get(key) ?? 0n) -
        (owed.get(key) ?? 0n) -
        (input.collected.get(key) ?? 0n) -
        e.portfolioMargin.posted;
      if (unsecured <= 0n) continue;
      r.unsecured += unsecured;
      if (!r.largest || unsecured > r.largest.amount) {
        r.largest = { memberId, name: input.names.get(memberId) ?? memberId, amount: unsecured };
      }
    }
  }
  for (const c of input.calls) {
    const r = row(c.currency);
    r.marginCalls.count += 1;
    r.marginCalls.amount += c.amount;
  }
  for (const c of input.cards) row(c.currency).cardsFronted += c.amount;
  return [...rows.values()]
    .filter(
      (r) =>
        r.payable !== 0n ||
        r.defaultFund !== 0n ||
        r.marginCalls.count > 0 ||
        r.cardsFronted !== 0n,
    )
    .sort((a, b) => a.currency.localeCompare(b.currency));
}
