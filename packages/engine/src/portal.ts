import { DomainError } from '@novate/core';
import {
  cycles,
  dealEvents,
  dealFacts,
  decisionCases,
  decisionRecords,
  fxConversions,
  ledgerAccounts,
  ledgerTransfers,
  members,
  obligations,
  settlementInstructions,
  type Tx,
} from '@novate/db';
import { and, asc, desc, eq, inArray, notInArray, or } from 'drizzle-orm';
import { claimDeadline } from './claims.ts';
import { paidAtOf } from './cycle-views.ts';
import { deps } from './deps.ts';
import { MEMBER_FX_KINDS, memberFxExchanges } from './member-fx.ts';
import { impliedRateE8, rateLabel, rateString } from './rates.ts';
import { type DealEventType, type DealRow, inTenant } from './repo.ts';

/** House bookkeeping a party has no use for: the resolved policy and how locks were sized. */
const INTERNAL_EVENTS: DealEventType[] = ['policy_resolved', 'locks_planned'];
/** Condition traces name the program's internals. A party sees only where things stand. */
const PARTY_PAYLOAD_HIDDEN = ['trace', 'checks', 'overrides'];

/**
 * A deal's history as a party to it sees it: what happened, and how each case about it ended and
 * who ended it, without the policy snapshot, the binding hashes or what deciders were shown.
 */
export async function partyHistory(db: Tx, dealId: string) {
  const [events, cases] = await Promise.all([
    db
      .select({
        seq: dealEvents.seq,
        type: dealEvents.type,
        payload: dealEvents.payload,
        at: dealEvents.createdAt,
      })
      .from(dealEvents)
      .where(and(eq(dealEvents.dealId, dealId), notInArray(dealEvents.type, INTERNAL_EVENTS)))
      .orderBy(asc(dealEvents.seq)),
    db
      .select()
      .from(decisionCases)
      .where(eq(decisionCases.dealId, dealId))
      .orderBy(asc(decisionCases.createdAt)),
  ]);
  const accepted = cases.length
    ? await db
        .select({
          caseId: decisionRecords.caseId,
          rationale: decisionRecords.rationale,
          deciderType: decisionRecords.deciderType,
          action: decisionRecords.action,
        })
        .from(decisionRecords)
        .where(
          and(
            inArray(
              decisionRecords.caseId,
              cases.map((c) => c.id),
            ),
            eq(decisionRecords.accepted, 1),
          ),
        )
        .orderBy(desc(decisionRecords.createdAt))
    : [];
  return {
    events: events.map((e) => ({
      ...e,
      payload: Object.fromEntries(
        Object.entries(e.payload).filter(([k]) => !PARTY_PAYLOAD_HIDDEN.includes(k)),
      ),
    })),
    cases: cases.map((c) => {
      const context = c.context as { amount?: string; currency?: string };
      const { resolution } = c;
      const record = accepted.find(
        (r) => r.caseId === c.id && r.action.type === resolution?.action.type,
      );
      return {
        id: c.id,
        kind: c.kind,
        reason: c.reason,
        status: c.status,
        amount: context.amount ?? null,
        currency: context.currency ?? null,
        openedAt: c.createdAt,
        closedAt: c.closedAt,
        decision: resolution
          ? {
              action: resolution.action,
              deciderType: record?.deciderType ?? null,
              rationale: record?.rationale ?? null,
            }
          : null,
      };
    }),
  };
}

/**
 * The claims filed against a settled deal, by either side, and how each ended, with when the
 * window for new ones closes. A claim is the dispute fact that opened a claim case; one filed while
 * another was open joined that case as evidence and is not listed on its own.
 */
export async function partyClaims(db: Tx, deal: DealRow) {
  const events = await db
    .select({ type: dealEvents.type, payload: dealEvents.payload, at: dealEvents.createdAt })
    .from(dealEvents)
    .where(
      and(
        eq(dealEvents.dealId, deal.id),
        inArray(dealEvents.type, [
          'settled',
          'claim_filed',
          'claim_refunded',
          'claim_paid',
          'claim_closed',
        ]),
      ),
    )
    .orderBy(asc(dealEvents.seq));
  const settledAt = events.findLast((e) => e.type === 'settled')?.at ?? null;
  const filed = events.filter((e) => e.type === 'claim_filed');
  const factIds = filed.map((e) => String(e.payload.factId));
  const [facts, cases] = await Promise.all([
    factIds.length
      ? db.select().from(dealFacts).where(inArray(dealFacts.id, factIds))
      : Promise.resolve([]),
    db
      .select({ id: decisionCases.id, context: decisionCases.context })
      .from(decisionCases)
      .where(and(eq(decisionCases.dealId, deal.id), eq(decisionCases.kind, 'exception'))),
  ]);
  const claims = filed.map((e) => {
    const factId = String(e.payload.factId);
    const data = facts.find((f) => f.id === factId)?.data ?? {};
    const caseId = cases.find(
      (c) => (c.context as { claim?: { factId?: string } }).claim?.factId === factId,
    )?.id;
    const refunded = events.find(
      (r) =>
        r.type === 'claim_refunded' &&
        (r.payload.factId === factId || (caseId && r.payload.caseId === caseId)),
    );
    const paid = events.find((r) => r.type === 'claim_paid' && r.payload.factId === factId);
    const closed = events.find((r) => r.type === 'claim_closed' && r.payload.factId === factId);
    const status = refunded ? 'refunded' : paid ? 'paid' : closed ? 'closed' : 'open';
    return {
      id: factId,
      at: e.at,
      by: e.payload.memberId === deal.sellerMemberId ? ('seller' as const) : ('buyer' as const),
      reason: typeof data.reason === 'string' ? data.reason : null,
      category: typeof data.category === 'string' ? data.category : null,
      amount: typeof data.amount === 'string' ? BigInt(data.amount) : null,
      status: status as 'open' | 'refunded' | 'paid' | 'closed',
      outcome: refunded
        ? { type: 'refunded', amount: BigInt(String(refunded.payload.amount)), at: refunded.at }
        : paid
          ? { type: 'paid', amount: BigInt(String(paid.payload.amount)), at: paid.at }
          : closed
            ? { type: String(closed.payload.outcome), at: closed.at }
            : null,
    };
  });
  return {
    claimUntil: deal.status === 'settled' || claims.length ? claimDeadline(deal, settledAt) : null,
    claims,
  };
}

/**
 * One cycle as a member sees it: only its own obligations, its net position per currency, its
 * payments in and out, and the conversions made with its money.
 */
export async function memberCycle(tenantId: string, memberId: string, cycleId: string) {
  const { db } = deps();
  const [found] = await db.select().from(cycles).where(eq(cycles.id, cycleId));
  const cycle = inTenant(found, tenantId, 'Cycle');
  const [owedRows, instructions] = await Promise.all([
    db
      .select()
      .from(obligations)
      .where(
        and(
          eq(obligations.cycleId, cycleId),
          or(eq(obligations.payerMemberId, memberId), eq(obligations.payeeMemberId, memberId)),
        ),
      ),
    db
      .select()
      .from(settlementInstructions)
      .where(
        and(
          eq(settlementInstructions.cycleId, cycleId),
          eq(settlementInstructions.memberId, memberId),
        ),
      ),
  ]);
  if (!owedRows.length && !instructions.length) {
    throw new DomainError('not_found', 'Cycle not found');
  }
  const counterparties = [
    ...new Set(
      owedRows.map((o) => (o.payerMemberId === memberId ? o.payeeMemberId : o.payerMemberId)),
    ),
  ];
  const [names, paidAt] = await Promise.all([
    counterparties.length
      ? db
          .select({ id: members.id, name: members.name })
          .from(members)
          .where(inArray(members.id, counterparties))
      : Promise.resolve([]),
    paidAtOf(
      db,
      instructions.map((i) => i.id),
    ),
  ]);
  const positions = new Map<string, { currency: string; owes: bigint; owed: bigint }>();
  for (const o of owedRows) {
    const p = positions.get(o.currency) ?? { currency: o.currency, owes: 0n, owed: 0n };
    if (o.payerMemberId === memberId) p.owes += o.amount;
    if (o.payeeMemberId === memberId) p.owed += o.amount;
    positions.set(o.currency, p);
  }
  return {
    cycle: {
      id: cycle.id,
      status: cycle.status,
      settlementGroup: cycle.settlementGroup,
      createdAt: cycle.createdAt,
      closedAt: cycle.closedAt,
    },
    owed: owedRows.map((o) => ({
      dealId: o.dealId,
      leg: o.leg,
      side: o.payerMemberId === memberId ? ('payer' as const) : ('payee' as const),
      counterpartyId: o.payerMemberId === memberId ? o.payeeMemberId : o.payerMemberId,
      counterpartyName:
        names.find(
          (n) => n.id === (o.payerMemberId === memberId ? o.payeeMemberId : o.payerMemberId),
        )?.name ?? null,
      amount: o.amount,
      currency: o.currency,
    })),
    position: [...positions.values()].map((p) => ({ ...p, net: p.owed - p.owes })),
    instructions: instructions.map((i) => ({
      id: i.id,
      direction: i.direction,
      currency: i.currency,
      amount: i.amount,
      rail: i.rail,
      status: i.status,
      attempt: i.attempt,
      externalRef: i.externalRef,
      failureReason: i.failureReason,
      updatedAt: i.updatedAt,
      /** When the rail first confirmed it, or null while it is not paid. */
      paidAt: paidAt.get(i.id) ?? null,
    })),
    converted: await memberConversions(db, tenantId, memberId, cycleId),
  };
}

/**
 * What the house exchanged for this member in the cycle. Each exchange is one ledger batch: sales
 * out of the escrow of the deals it pays for, and a purchase into its position in the cycle.
 */
async function memberConversions(db: Tx, tenantId: string, memberId: string, cycleId: string) {
  const [legs, house] = await Promise.all([
    db
      .select({
        batchId: ledgerTransfers.batchId,
        kind: ledgerTransfers.kind,
        currency: ledgerTransfers.currency,
        amount: ledgerTransfers.amount,
        creditMember: ledgerAccounts.memberId,
      })
      .from(ledgerTransfers)
      .innerJoin(ledgerAccounts, eq(ledgerAccounts.id, ledgerTransfers.creditAccountId))
      .where(
        and(
          eq(ledgerTransfers.tenantId, tenantId),
          eq(ledgerTransfers.ref, cycleId),
          inArray(ledgerTransfers.kind, [...MEMBER_FX_KINDS]),
        ),
      ),
    db
      .select()
      .from(fxConversions)
      .where(eq(fxConversions.cycleId, cycleId))
      .orderBy(desc(fxConversions.createdAt)),
  ]);
  // A purchase is credited to the member's position in the cycle, which says whose exchange it is.
  const mine = new Set(
    legs
      .filter((l) => l.kind === 'fx_member_buy' && l.creditMember === memberId)
      .map((l) => l.batchId),
  );
  const exchanges = memberFxExchanges(legs.filter((l) => mine.has(l.batchId)));
  const out: {
    sellCurrency: string;
    sellAmount: bigint;
    buyCurrency: string;
    buyAmount: bigint;
    houseRateE8: bigint | null;
    externalRef: string | null;
    /**
     * The house's conversion on the rail for this pair, latest first; null when the house already
     * held the currency, so the exchange was only booked.
     */
    status: 'submitted' | 'confirmed' | 'failed' | null;
    /** Units of the bought currency per 1 sold: the house's rate, or what this member got. */
    rate: string | null;
    rateLabel: string | null;
  }[] = [];
  for (const e of exchanges) {
    const existing = out.find(
      (o) => o.sellCurrency === e.sellCurrency && o.buyCurrency === e.buyCurrency,
    );
    if (existing) {
      existing.sellAmount += e.sold;
      existing.buyAmount += e.bought;
      continue;
    }
    const conversion = house.find(
      (c) => c.sellCurrency === e.sellCurrency && c.buyCurrency === e.buyCurrency,
    );
    out.push({
      sellCurrency: e.sellCurrency,
      sellAmount: e.sold,
      buyCurrency: e.buyCurrency,
      buyAmount: e.bought,
      houseRateE8: conversion?.status === 'confirmed' ? conversion.rateE8 : null,
      externalRef: conversion?.externalRef ?? null,
      status: conversion?.status ?? null,
      rate: null,
      rateLabel: null,
    });
  }
  for (const o of out) {
    const rateE8 =
      o.houseRateE8 ?? impliedRateE8(o.sellAmount, o.sellCurrency, o.buyAmount, o.buyCurrency);
    if (!rateE8) continue;
    o.rate = rateString(rateE8);
    o.rateLabel = rateLabel(o.sellCurrency, o.buyCurrency, rateE8);
  }
  return out;
}
