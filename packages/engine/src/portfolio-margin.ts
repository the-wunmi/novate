import { DBOS } from '@dbos-inc/dbos-sdk';
import { minBig, mulDivUp } from '@novate/core';
import { deals, marginCalls, members, positionMarks, type Tx } from '@novate/db';
import { type MarginRequirement, marginRequirement, type OpenExposure } from '@novate/fx';
import { Accounts } from '@novate/ledger';
import { type Decisions, durationMs, type PortfolioMargin } from '@novate/policy';
import { and, eq, inArray, lte, or } from 'drizzle-orm';
import { resolveCase } from './decisions.ts';
import { deps, isWorkflowControl, networkStep, tryPost, tx } from './deps.ts';
import { memberHoldings } from './funds.ts';
import { currencyVolatility } from './fx-signal.ts';
import { notify } from './notifications.ts';
import { type DealRow, fundingRecords, snapshotOf } from './repo.ts';

type Params = Extract<PortfolioMargin, { mode: 'required' }>;
type MemberRow = typeof members.$inferSelect;
type CallRow = typeof marginCalls.$inferSelect;

/** Everything from acceptance to final settlement is a position the house is exposed to. */
const EXPOSED = [
  'authorised',
  'awaiting_funding',
  'awaiting_conditions',
  'held',
  'eligible',
  'settling',
] as const;
const E8 = 100_000_000n;
/** Rates move a little all day. Margin only goes back once it is clearly more than needed. */
const RELEASE_BUFFER_BPS = 100n;

interface Position {
  deal: DealRow;
  params: Params;
  decisions: Decisions;
  rail: string;
}

interface Book {
  member: MemberRow;
  positions: Position[];
}

interface Market {
  rates: Map<string, bigint>;
  volatility: Map<string, number>;
}

export interface Assessment {
  memberId: string;
  currency: string;
  required: bigint;
  posted: bigint;
  shortfall: bigint;
  breakdown: MarginRequirement;
  /** Absent when the member has no position left to take terms from. */
  terms?: { params: Params; decisions: Decisions };
}

export interface PortfolioSummary {
  assessed: number;
  calls: number;
  extended: number;
  defaults: number;
}

const pairKey = (currency: string, home: string) => `${currency}/${home}`;

function positionOf(deal: DealRow): Position | null {
  const policy = snapshotOf(deal).resolved.policy;
  // Deals snapshotted before this block existed have nothing to assess.
  if (policy.portfolioMargin?.mode !== 'required') return null;
  return {
    deal,
    params: policy.portfolioMargin,
    decisions: policy.decisions,
    rail: policy.settlement.rail,
  };
}

async function positionsOf(db: Tx, tenantId: string, memberId?: string): Promise<Position[]> {
  const open = await db
    .select()
    .from(deals)
    .where(
      and(
        eq(deals.tenantId, tenantId),
        inArray(deals.status, [...EXPOSED]),
        memberId
          ? or(eq(deals.buyerMemberId, memberId), eq(deals.sellerMemberId, memberId))
          : undefined,
      ),
    );
  return open.flatMap((d) => positionOf(d) ?? []);
}

/** Every member with an open position, collateral that may be due back, or a call to clear. */
async function loadBooks(db: Tx, tenantId: string, only?: string[]): Promise<Book[]> {
  const positions = await positionsOf(db, tenantId);
  const holding = await memberHoldings(db, tenantId, 'portfolio_margin');
  const calls = await db
    .select({ memberId: marginCalls.memberId })
    .from(marginCalls)
    .where(and(eq(marginCalls.tenantId, tenantId), eq(marginCalls.status, 'open')));
  const ids = new Set([
    ...positions.flatMap((p) => [p.deal.buyerMemberId, p.deal.sellerMemberId]),
    ...holding.map((h) => h.memberId),
    ...calls.map((c) => c.memberId),
  ]);
  const wanted = only ? [...ids].filter((id) => only.includes(id)) : [...ids];
  if (!wanted.length) return [];
  const rows = await db.select().from(members).where(inArray(members.id, wanted));
  return rows.map((member) => ({
    member,
    positions: positions.filter(
      (p) => p.deal.buyerMemberId === member.id || p.deal.sellerMemberId === member.id,
    ),
  }));
}

/** Rates and volatilities for every pair in these books. A pair the rail cannot price is left out. */
async function readMarket(books: Book[]): Promise<Market> {
  const market: Market = { rates: new Map(), volatility: new Map() };
  for (const { member, positions } of books) {
    for (const { deal, rail } of positions) {
      if (deal.currency === member.homeCurrency) continue;
      const key = pairKey(deal.currency, member.homeCurrency);
      if (market.rates.has(key)) continue;
      try {
        const quote = await networkStep('margin_quote', () =>
          deps().rails.get(rail).quote(deal.currency, member.homeCurrency),
        );
        market.rates.set(key, quote.rateE8);
      } catch (err) {
        if (isWorkflowControl(err)) throw err;
        console.error(`No rate for ${key}, skipping members who need it:`, err);
      }
      if (!market.volatility.has(deal.currency)) {
        const { vol30d } = await DBOS.runStep(() => currencyVolatility(deps().db, deal.currency), {
          name: 'margin_volatility',
        });
        market.volatility.set(deal.currency, vol30d);
      }
    }
  }
  return market;
}

const priced = (book: Book, market: Market) =>
  book.positions.every(
    ({ deal }) =>
      deal.currency === book.member.homeCurrency ||
      market.rates.has(pairKey(deal.currency, book.member.homeCurrency)),
  );

/** What a position is worth to this member. Prefunded money is already held, so it is not owed. */
function signedAmount({ deal }: Position, memberId: string): bigint {
  if (deal.sellerMemberId === memberId) return deal.amount;
  const prefundedBps = BigInt(snapshotOf(deal).resolved.fundingBps);
  return -mulDivUp(deal.amount, 10_000n - prefundedBps, 10_000n);
}

async function exposuresOf(
  db: Tx,
  book: Book,
  market: Market,
): Promise<{ position: Position; exposure: OpenExposure }[]> {
  const { member, positions } = book;
  const rateNow = (currency: string) =>
    currency === member.homeCurrency
      ? E8
      : (market.rates.get(pairKey(currency, member.homeCurrency)) as bigint);
  if (!positions.length) return [];
  await db
    .insert(positionMarks)
    .values(
      positions.map(({ deal }) => ({
        dealId: deal.id,
        memberId: member.id,
        rateE8: rateNow(deal.currency),
      })),
    )
    .onConflictDoNothing();
  const marks = await db
    .select()
    .from(positionMarks)
    .where(
      and(
        eq(positionMarks.memberId, member.id),
        inArray(
          positionMarks.dealId,
          positions.map((p) => p.deal.id),
        ),
      ),
    );
  const booked = new Map(marks.map((m) => [m.dealId, m.rateE8]));
  return positions.map((position) => ({
    position,
    exposure: {
      currency: position.deal.currency,
      amount: signedAmount(position, member.id),
      bookedRateE8: booked.get(position.deal.id) as bigint,
    },
  }));
}

const ZERO: MarginRequirement = { required: 0n, exposure: 0n, base: 0n, stress: 0n, variation: 0n };

/** Programs can set different terms, so each is sized on its own and the results added. */
function requirementOf(
  book: Book,
  market: Market,
  open: Awaited<ReturnType<typeof exposuresOf>>,
): MarginRequirement {
  const home = book.member.homeCurrency;
  const byProgram = Map.groupBy(open, (o) => o.position.deal.programId);
  let total = ZERO;
  for (const list of byProgram.values()) {
    const r = marginRequirement(
      {
        home,
        exposures: list.map((o) => o.exposure),
        rate: (c) => market.rates.get(pairKey(c, home)) as bigint,
        volatility: (c) => market.volatility.get(c) ?? 0,
      },
      (list[0] as (typeof list)[number]).position.params,
    );
    total = {
      required: total.required + r.required,
      exposure: total.exposure + r.exposure,
      base: total.base + r.base,
      stress: total.stress + r.stress,
      variation: total.variation + r.variation,
    };
  }
  return total;
}

async function openCall(db: Tx, memberId: string): Promise<CallRow | undefined> {
  const [call] = await db
    .select()
    .from(marginCalls)
    .where(and(eq(marginCalls.memberId, memberId), eq(marginCalls.status, 'open')));
  return call;
}

/** False if the call was already closed, such as by money arriving while a model was deciding. */
async function closeCall(db: Tx, call: CallRow, status: 'met' | 'defaulted'): Promise<boolean> {
  const closed = await db
    .update(marginCalls)
    .set({ status, closedAt: new Date() })
    .where(and(eq(marginCalls.id, call.id), eq(marginCalls.status, 'open')))
    .returning({ id: marginCalls.id });
  return closed.length > 0;
}

/**
 * Size one member's requirement and bring its collateral to it, from its wallet where possible.
 * The member row is locked, so a deal and the monitor cannot both collect the same shortfall.
 */
async function assessMember(
  db: Tx,
  tenantId: string,
  memberId: string,
  market: Market,
  now: number,
): Promise<Assessment | undefined> {
  const [member] = await db.select().from(members).where(eq(members.id, memberId)).for('update');
  // Read after the lock: a position opened since the market was read has to count.
  const book: Book = {
    member: member as MemberRow,
    positions: await positionsOf(db, tenantId, memberId),
  };
  if (!priced(book, market)) return undefined;
  const currency = book.member.homeCurrency;

  const { ledger } = deps();
  const breakdown = requirementOf(book, market, await exposuresOf(db, book, market));
  const { required } = breakdown;
  const account = Accounts.memberPortfolioMargin(memberId, currency);
  const wallet = Accounts.memberAvailable(memberId, currency);
  let posted = await ledger.balance(db, tenantId, account);
  let shortfall = 0n;

  if (posted < required) {
    const take = minBig(required - posted, await ledger.balance(db, tenantId, wallet));
    const moved =
      take > 0n &&
      (await tryPost(db, tenantId, [
        {
          key: `portfolio:${memberId}:${now}:${posted}:call`,
          debit: wallet,
          credit: account,
          amount: take,
          kind: 'portfolio_margin_call',
          ref: memberId,
        },
      ]));
    if (moved) posted += take;
    shortfall = required - posted;
  } else if (posted - required > mulDivUp(required, RELEASE_BUFFER_BPS, 10_000n)) {
    const excess = posted - required;
    await ledger.post(db, tenantId, [
      {
        key: `portfolio:${memberId}:${now}:${posted}:release`,
        debit: account,
        credit: wallet,
        amount: excess,
        kind: 'portfolio_margin_release',
        ref: memberId,
      },
    ]);
    posted = required;
  }

  const first = book.positions[0];
  const call = await openCall(db, memberId);
  if (shortfall === 0n && call) await closeCall(db, call, 'met');
  if (shortfall > 0n && first) {
    if (call) {
      // The amount tracks the market, but the deadline must not move with it.
      await db.update(marginCalls).set({ amount: shortfall }).where(eq(marginCalls.id, call.id));
    } else {
      await db.insert(marginCalls).values({
        tenantId,
        memberId,
        currency,
        amount: shortfall,
        dueAt: new Date(now + durationMs(first.params.callWindow)),
      });
    }
  }
  return {
    memberId,
    currency,
    required,
    posted,
    shortfall,
    breakdown,
    terms: first && { params: first.params, decisions: first.decisions },
  };
}

/** Value positions at today's rates and bring each member's collateral into line. */
export async function assessMembers(tenantId: string, only?: string[]): Promise<Assessment[]> {
  const books = await tx('margin_books', (db) => loadBooks(db, tenantId, only));
  if (!books.length) return [];
  const market = await readMarket(books);
  const now = await DBOS.now();
  const out: Assessment[] = [];
  // A member whose currency cannot be priced today is left alone rather than judged on old rates.
  for (const { member } of books) {
    const assessed = await tx('margin_assess', (db) =>
      assessMember(db, tenantId, member.id, market, now),
    );
    if (assessed) out.push(assessed);
  }
  return out;
}

/** Pre-trade check: a member already short of margin may not add to what it owes. */
export async function marginCoversDeal(deal: DealRow): Promise<boolean> {
  const parties = [deal.buyerMemberId, deal.sellerMemberId];
  const assessed = await assessMembers(deal.tenantId, parties);
  return assessed.length === parties.length && assessed.every((a) => a.shortfall === 0n);
}

/** Bring every member into line, then decide what happens to calls that have run out of time. */
export async function reviewPortfolioMargin(tenantId: string): Promise<PortfolioSummary> {
  const assessed = await assessMembers(tenantId);
  const now = new Date(await DBOS.now());
  const due = await tx('margin_due', (db) =>
    db
      .select()
      .from(marginCalls)
      .where(
        and(
          eq(marginCalls.tenantId, tenantId),
          eq(marginCalls.status, 'open'),
          lte(marginCalls.dueAt, now),
        ),
      ),
  );
  const summary: PortfolioSummary = {
    assessed: assessed.length,
    calls: assessed.filter((a) => a.shortfall > 0n).length,
    extended: 0,
    defaults: 0,
  };
  for (const call of due) {
    const assessment = assessed.find((a) => a.memberId === call.memberId);
    // Only act on a shortfall measured just now, and one that has not since been met.
    if (assessment?.terms && assessment.shortfall > 0n) {
      await decideDueCall(call, assessment, assessment.terms, summary);
    }
  }
  return summary;
}

async function decideDueCall(
  call: CallRow,
  assessment: Assessment,
  { params, decisions }: NonNullable<Assessment['terms']>,
  summary: PortfolioSummary,
) {
  const { memberId } = call;
  const attemptsLeft = Math.max(0, params.maxExtensions - call.extensions);
  const record = await tx('margin_record', (db) => fundingRecords(db, call.tenantId, [memberId]));
  const res = await resolveCase({
    tenantId: call.tenantId,
    kind: 'margin_breach',
    subjectType: 'member',
    subjectId: memberId,
    reason: `Member is ${assessment.shortfall} ${assessment.currency} short of its margin call`,
    evidence: {
      memberId,
      shortfall: assessment.shortfall,
      required: assessment.required,
      posted: assessment.posted,
      breakdown: assessment.breakdown,
      currency: assessment.currency,
      extensionsUsed: call.extensions,
      attemptsLeft,
      record,
    },
    amount: assessment.shortfall,
    currency: assessment.currency,
    decisions,
    attemptsLeft,
    skipPerson: true,
  });

  // Nobody deciding is not a verdict. It uses up an extension, so a long outage still ends in one.
  const undecided = res.outcome !== 'decided';
  if (
    (res.outcome === 'decided' && res.action.type === 'extend_call') ||
    (undecided && attemptsLeft)
  ) {
    const dueAt = new Date((await DBOS.now()) + durationMs(params.callWindow));
    await tx('margin_extend', (db) =>
      db
        .update(marginCalls)
        .set({ dueAt, extensions: call.extensions + 1 })
        .where(and(eq(marginCalls.id, call.id), eq(marginCalls.status, 'open'))),
    );
    summary.extended++;
    if (undecided) {
      await notify({
        type: 'case_needs_person',
        tenantId: call.tenantId,
        caseId: res.caseId,
        kind: 'margin_breach',
        reason: `Margin call on ${memberId} needs a decision`,
      });
    }
    return;
  }
  const defaulted = await tx('margin_default', async (db) => {
    if (!(await closeCall(db, call, 'defaulted'))) return false;
    // Only from active: a member already suspended must stay shut out of settlement.
    await db
      .update(members)
      .set({ status: 'close_only' })
      .where(and(eq(members.id, memberId), eq(members.status, 'active')));
    return true;
  });
  if (!defaulted) return;
  summary.defaults++;
  await notify({
    type: 'member_defaulted',
    tenantId: call.tenantId,
    memberId,
    caseId: res.caseId,
    reason: 'Did not meet a margin call in time. New positions are refused until reinstated.',
  });
}

/** Collateral and any open call, as the member and the platform see them. */
export async function memberMargin(tenantId: string, memberId: string) {
  const { db } = deps();
  const [call] = await db
    .select()
    .from(marginCalls)
    .where(
      and(
        eq(marginCalls.tenantId, tenantId),
        eq(marginCalls.memberId, memberId),
        eq(marginCalls.status, 'open'),
      ),
    );
  const posted = await tx('member_margin', async (t) =>
    (await memberHoldings(t, tenantId, 'portfolio_margin')).filter((h) => h.memberId === memberId),
  );
  return {
    posted: posted.map(({ currency, amount }) => ({ currency, amount })),
    openCall: call ?? null,
  };
}

export const openMarginCalls = (tenantId: string) =>
  deps()
    .db.select()
    .from(marginCalls)
    .where(and(eq(marginCalls.tenantId, tenantId), eq(marginCalls.status, 'open')));
