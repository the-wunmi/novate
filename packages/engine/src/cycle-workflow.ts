import { DBOS } from '@dbos-inc/dbos-sdk';
import { minBig, mulDivUp } from '@novate/core';
import {
  cycles,
  deals,
  fxConversions,
  marginCalls,
  members,
  obligations,
  settlementInstructions,
  type Tx,
  tenants,
} from '@novate/db';
import {
  boughtAtMarket,
  type FxCollateral,
  type FxNeed,
  type FxPlan,
  type MarketConversion,
  type MemberExchange,
  planFx,
} from '@novate/fx';
import { type AccountSpec, Accounts, type TransferInput } from '@novate/ledger';
import { type NettableObligation, type NettingMode, net } from '@novate/netting';
import { durationMs, type ResolvedPolicy, Settlement } from '@novate/policy';
import type { FxResult, RailResult, SettlementRail } from '@novate/rails';
import { and, asc, desc, eq, inArray, notInArray, or } from 'drizzle-orm';
import type { SettlementMessage } from './deal-workflow.ts';
import { type CaseResolution, type CaseSpec, resolveCase } from './decisions.ts';
import { deps, isWorkflowControl, networkStep, pollWhileSubmitted, tryPost, tx } from './deps.ts';
import { memberHoldings } from './funds.ts';
import { notify } from './notifications.ts';
import { strictestDecisions } from './reconciliation.ts';
import {
  escrowCurrency,
  fundingRecords,
  getMember,
  haltSettlement,
  type PolicySnapshot,
  record,
} from './repo.ts';
import { parseGroup, shortKey } from './settlement-group.ts';
import { Topics } from './topics.ts';

/** Internal rail: credit the member's wallet at the house instead of paying out externally. */
export const WALLET_RAIL = 'wallet';

/** How many times deciders can send a default or a failed payout round again. */
const MAX_RETRIES = 3;

export const PLAN_CONVERT_NOW = 'convert_now';
export const PLAN_DEFER_CYCLE = 'defer_cycle';

type Instruction = typeof settlementInstructions.$inferSelect;
type Policy = ResolvedPolicy['policy'];
type Totals = ReturnType<typeof net>['totals'];

export interface CycleSummary {
  cycleId: string;
  status: 'settled' | 'failed' | 'empty' | 'halted' | 'deferred';
  obligations: number;
  totals: Totals;
  failures: { memberId: string; reason: string }[];
  /** What went to the FX market, against what would have without netting. */
  fx?: { boughtNet: Record<string, bigint>; boughtGross: Record<string, bigint> };
}

/** Everything fixed for the life of a cycle, passed to every step instead of being looked up. */
interface PayoutRun {
  tenantId: string;
  cycleId: string;
  rail: SettlementRail;
  policy: Pick<Policy, 'decisions' | 'settlement'>;
}

interface CycleRun extends PayoutRun {
  group: string;
  policy: Policy;
}

/** A shortfall to fund this round, and the total the member's position must reach. */
interface Debt extends FxNeed {
  target: bigint;
}

interface Default {
  memberId: string;
  reason: string;
}

const summary = (
  cycleId: string,
  status: CycleSummary['status'],
  extra: Partial<CycleSummary> = {},
): CycleSummary => ({ cycleId, status, obligations: 0, totals: {}, failures: [], ...extra });

/**
 * One clearing cycle for one settlement group. Takes every eligible obligation, nets them, funds
 * net debtors, commits, then pays net creditors. A default re-nets the rest or is absorbed by the
 * house, depending on who carries risk. No state is left stranded.
 */
async function clearingCycle(
  tenantId: string,
  cycleId: string,
  group: string,
  scheduled = false,
): Promise<CycleSummary> {
  try {
    return await settleGroup(tenantId, cycleId, group, scheduled);
  } catch (err) {
    if (isWorkflowControl(err)) throw err;
    return failSafe(tenantId, cycleId, err as Error);
  }
}

export const cycleWorkflow = DBOS.registerWorkflow(clearingCycle, { name: 'clearingCycle' });

/**
 * A cycle that breaks unexpectedly stops settlement for the tenant and tells someone. Before commit
 * its obligations go back in the queue. After commit money has been assigned, so a person decides.
 */
async function failSafe(tenantId: string, cycleId: string, err: Error): Promise<CycleSummary> {
  const reason = `Cycle ${cycleId} stopped: ${err.message}`.slice(0, 500);
  await tx('cycle_fail_safe', async (db) => {
    const [cycle] = await db.select().from(cycles).where(eq(cycles.id, cycleId));
    if (cycle?.status !== 'committed') {
      await returnCollected(db, tenantId, cycleId);
      await requeue(db, cycleId, 'cycle_failed');
    }
    await db
      .update(cycles)
      .set({ status: 'failed', closedAt: new Date(), summary: { error: reason } })
      .where(eq(cycles.id, cycleId));
    await haltSettlement(db, tenantId, reason);
  });
  await notify({ type: 'settlement_stopped', tenantId, reason });
  return summary(cycleId, 'failed', { failures: [{ memberId: 'house', reason }] });
}

async function settleGroup(
  tenantId: string,
  cycleId: string,
  group: string,
  scheduled: boolean,
): Promise<CycleSummary> {
  const halted = await tx('halted', async (db) => {
    const [t] = await db.select().from(tenants).where(eq(tenants.id, tenantId));
    return Boolean(t?.settlementHaltedAt);
  });
  if (halted) return summary(cycleId, 'halted');
  // Only a scheduled run can be held. Someone asking for settlement now gets it now.
  if (scheduled && (await treasuryHolds(tenantId, cycleId, group))) {
    await tx('treasury_hold', (db) =>
      db
        .insert(cycles)
        .values({
          id: cycleId,
          tenantId,
          settlementGroup: group,
          status: 'deferred',
          closedAt: new Date(),
        })
        .onConflictDoNothing(),
    );
    return summary(cycleId, 'deferred');
  }

  const policy = await tx('claim', (db) => claim(db, tenantId, cycleId, group));
  if (!policy) return summary(cycleId, 'empty');
  const run: CycleRun = {
    tenantId,
    cycleId,
    group,
    rail: deps().rails.get(parseGroup(group).rail),
    policy,
  };

  const failures: Default[] = [];
  let totals: Totals = {};
  let fx: CycleSummary['fx'];
  const quotes: Quotes = {};

  for (let attempt = 0; ; attempt++) {
    const round = await tx('round', (db) => roundState(db, run));
    if (!round.count) break;
    totals = round.totals;

    const plan = await planRound(run, round, quotes);
    fx = {
      boughtNet: boughtAtMarket(plan.conversions),
      boughtGross: boughtAtMarket(round.grossConversions),
    };

    if (await shouldDefer(run, attempt, round, plan)) {
      await tx('defer', (db) => deferCycle(db, run));
      return summary(cycleId, 'deferred', { totals, fx });
    }

    await executeFx(run, attempt, plan, quotes);
    const defaults = await fundDebts(run, attempt, round.debts);
    if (!defaults.length) break;
    failures.push(...defaults);

    if (policy.risk.bearer === 'principal') {
      const sold = await sellPortfolioMargin(run, attempt, defaults, round.debts);
      await tx('absorb', (db) => absorbDefaults(db, run, attempt, defaults, round.debts, sold));
      break;
    }
    const dropped = await membersToDrop(run, attempt, defaults, round.debts);
    if (dropped.length) await tx('exclude', (db) => excludeMembers(db, run, dropped));
  }

  const committed = await tx('commit', (db) => commit(db, run));
  // Paid before the empty check: a member collected before everyone dropped out is owed it back.
  for (const ins of committed.instructions) await payOut(run, ins);
  if (!committed.count) {
    await tx('close_empty', (db) => closeCycle(db, run, totals, 'failed', failures));
    return summary(cycleId, 'failed', { totals, failures });
  }

  const dealIds = await tx('close', (db) => closeCycle(db, run, totals, 'settled', failures));
  for (const dealId of dealIds) {
    const message: SettlementMessage = { type: 'settled', cycleId };
    await DBOS.send(dealId, message, Topics.settled, `${cycleId}:${dealId}`);
  }
  return summary(cycleId, 'settled', { obligations: dealIds.length, totals, failures, fx });
}

const exceptionCase = (
  run: PayoutRun,
  reason: string,
  evidence: Record<string, unknown>,
  extra: Pick<CaseSpec, 'amount' | 'currency'> & Partial<CaseSpec>,
): CaseSpec => ({
  tenantId: run.tenantId,
  kind: 'settlement_exception',
  subjectType: 'cycle',
  subjectId: run.cycleId,
  reason,
  evidence,
  decisions: run.policy.decisions,
  skipPerson: true,
  ...extra,
});

const wantsRetry = (decision: CaseResolution, attempt: number) =>
  decision.outcome === 'decided' &&
  decision.action.type === 'retry_settlement' &&
  attempt < MAX_RETRIES;

/**
 * The need closest to its ceiling, so the limit is checked against what matters most. Comparing
 * raw amounts would let a large number of yen hide a larger value in euros.
 */
function mostAtStake(needs: FxNeed[], ceiling: Record<string, number>): FxNeed | undefined {
  const pressure = (n: FxNeed) => {
    const limit = ceiling[n.currency];
    return limit
      ? (n.amount * 1_000_000n) / BigInt(limit)
      : BigInt(Number.MAX_SAFE_INTEGER) * n.amount;
  };
  return needs.reduce<FxNeed | undefined>(
    (top, n) => (!top || pressure(n) > pressure(top) ? n : top),
    undefined,
  );
}

/** Who leaves this cycle after a default. Nobody means the deciders want another attempt. */
async function membersToDrop(
  run: CycleRun,
  attempt: number,
  defaults: Default[],
  debts: Debt[],
): Promise<string[]> {
  const memberIds = defaults.map((d) => d.memberId);
  const owed = debts.filter((d) => memberIds.includes(d.member));
  const atStake = mostAtStake(owed, run.policy.decisions.ceiling) as FxNeed;
  const records = await tx('funding_records', (db) =>
    fundingRecords(db, run.tenantId, memberIds, run.cycleId),
  );
  const decision = await resolveCase(
    exceptionCase(
      run,
      `${defaults.length} member(s) could not fund this cycle`,
      { defaults, owed, records, attempt, retriesLeft: MAX_RETRIES - attempt },
      {
        amount: atStake.amount,
        currency: atStake.currency,
        memberIds,
        attemptsLeft: MAX_RETRIES - attempt,
        ruleVars: { attempt: BigInt(attempt) },
      },
    ),
  );
  if (wantsRetry(decision, attempt)) return [];
  if (decision.outcome === 'decided' && decision.action.type === 'exclude_member') {
    return [decision.action.memberId];
  }
  return memberIds;
}

// ── Claiming and netting ───────────────────────────────────────────────────

/** Take every eligible obligation in the group. Returns the policy they settle under, if any. */
async function claim(
  db: Tx,
  tenantId: string,
  cycleId: string,
  group: string,
): Promise<Policy | null> {
  await db
    .insert(cycles)
    .values({ id: cycleId, tenantId, settlementGroup: group })
    .onConflictDoNothing();
  const eligible = await db
    .select({ o: obligations, snapshot: deals.policySnapshot })
    .from(obligations)
    .innerJoin(deals, eq(deals.id, obligations.dealId))
    .where(
      and(
        eq(obligations.tenantId, tenantId),
        eq(obligations.status, 'eligible'),
        eq(obligations.settlementGroup, group),
      ),
    )
    .orderBy(asc(obligations.createdAt))
    .for('update', { of: obligations, skipLocked: true });
  const inactive = new Set(
    (
      await db
        .select({ id: members.id })
        .from(members)
        .where(and(eq(members.tenantId, tenantId), eq(members.status, 'suspended')))
    ).map((m) => m.id),
  );
  // A deal's obligations stay together, or a deal could finish with one of its legs still open.
  const blocked = new Set(
    eligible
      .filter(({ o }) => inactive.has(o.payerMemberId) || inactive.has(o.payeeMemberId))
      .map(({ o }) => o.dealId),
  );
  const rows = eligible.filter(({ o }) => !blocked.has(o.dealId));
  if (!rows.length) {
    await db
      .update(cycles)
      .set({ status: 'settled', closedAt: new Date(), summary: { obligations: 0 } })
      .where(eq(cycles.id, cycleId));
    return null;
  }
  await db
    .update(obligations)
    .set({ status: 'netted', cycleId })
    .where(
      inArray(
        obligations.id,
        rows.map((r) => r.o.id),
      ),
    );
  const dealIds = [...new Set(rows.map((r) => r.o.dealId))];
  await db.update(deals).set({ status: 'settling' }).where(inArray(deals.id, dealIds));
  for (const id of dealIds) await record(db, id, 'netted', { cycleId });
  await db.update(cycles).set({ status: 'settling' }).where(eq(cycles.id, cycleId));
  const [first] = rows as [(typeof rows)[number]];
  return (first.snapshot as unknown as PolicySnapshot).resolved.policy;
}

const nettedRows = (db: Tx, cycleId: string) =>
  db
    .select({ o: obligations, d: deals })
    .from(obligations)
    .innerJoin(deals, eq(deals.id, obligations.dealId))
    .where(and(eq(obligations.cycleId, cycleId), eq(obligations.status, 'netted')));

type NettedRow = Awaited<ReturnType<typeof nettedRows>>[number];
type Round = Awaited<ReturnType<typeof positionsOf>>;

const roundState = async (db: Tx, run: RoundKey) =>
  positionsOf(db, run, await nettedRows(db, run.cycleId));

type RoundKey = Pick<CycleRun, 'tenantId' | 'cycleId' | 'group'>;

async function positionsOf(db: Tx, run: RoundKey, rows: NettedRow[]) {
  const { ledger } = deps();
  const mode = parseGroup(run.group).netting as NettingMode;

  const items: NettableObligation[] = [];
  const collateral: FxCollateral[] = [];
  for (const { o, d } of rows) {
    let prefunded = 0n;
    if (o.leg === 'principal') {
      const currency = escrowCurrency(d);
      const held = await ledger.balance(db, run.tenantId, Accounts.dealEscrow(o.dealId, currency));
      if (currency === o.currency) prefunded = minBig(held, o.amount);
      else if (held > 0n) collateral.push({ member: o.payerMemberId, currency, amount: held });
    }
    items.push({
      id: o.id,
      payer: o.payerMemberId,
      payee: o.payeeMemberId,
      currency: o.currency,
      amount: o.amount,
      prefunded,
    });
  }
  const result = net(items, mode);

  const debts: Debt[] = [];
  for (const p of result.positions) {
    if (p.collect === 0n) continue;
    const already = await ledger.balance(
      db,
      run.tenantId,
      Accounts.cycleSettlement(run.cycleId, p.member, p.currency),
    );
    if (p.collect > already) {
      debts.push({
        member: p.member,
        currency: p.currency,
        amount: p.collect - already,
        target: p.collect,
      });
    }
  }

  return {
    count: rows.length,
    totals: result.totals,
    debts,
    collateral,
    grossConversions: grossBaseline(rows),
  };
}

/** Every obligation with foreign collateral converted on its own, in the deal's currency. */
function grossBaseline(rows: NettedRow[]): MarketConversion[] {
  const foreign = rows.filter(({ o, d }) => escrowCurrency(d) !== o.currency);
  const direct = foreign.map(({ o, d }) => ({
    sellCurrency: escrowCurrency(d),
    buyCurrency: o.currency,
    buyAmount: o.amount,
  }));
  // Receiving euros and converting them home is the same notional, the other way round.
  const home = new Map(foreign.map(({ o, d }) => [o.payerMemberId, escrowCurrency(d)]));
  const receipts = rows.flatMap(({ o, d }) => {
    const sellCurrency = home.get(o.payeeMemberId);
    return sellCurrency && escrowCurrency(d) === o.currency
      ? [{ sellCurrency, buyCurrency: o.currency, buyAmount: o.amount }]
      : [];
  });
  return [...direct, ...receipts];
}

// ── Treasury ───────────────────────────────────────────────────────────────

const eligibleRows = (db: Tx, tenantId: string, group: string) =>
  db
    .select({ o: obligations, d: deals })
    .from(obligations)
    .innerJoin(deals, eq(deals.id, obligations.dealId))
    .where(
      and(
        eq(obligations.tenantId, tenantId),
        eq(obligations.status, 'eligible'),
        eq(obligations.settlementGroup, group),
      ),
    );

/** What the cycle would do if it ran now, or null if there is nothing for an agent to weigh. */
async function treasuryView(db: Tx, key: RoundKey) {
  const { tenantId, group } = key;
  const rows = await eligibleRows(db, tenantId, group);
  if (!rows.length) return null;
  const policy = (rows[0] as NettedRow).d.policySnapshot as unknown as PolicySnapshot;
  const { treasury } = policy.resolved.policy;
  if (treasury?.mode !== 'agent') return null;

  const recent = await db
    .select({ status: cycles.status })
    .from(cycles)
    .where(eq(cycles.settlementGroup, group))
    .orderBy(desc(cycles.createdAt))
    .limit(treasury.maxDeferrals + 1);
  const firstOther = recent.findIndex((c) => c.status !== 'deferred');
  const held = firstOther === -1 ? recent.length : firstOther;
  if (held >= treasury.maxDeferrals) return null;

  const round = await positionsOf(db, key, rows);
  const unfunded: Debt[] = [];
  for (const debt of round.debts) {
    const wallet = Accounts.memberAvailable(debt.member, debt.currency);
    if ((await deps().ledger.balance(db, tenantId, wallet)) < debt.amount) unfunded.push(debt);
  }
  // Where deals locked at different rates, the highest is the one the market has moved furthest from.
  const lockedRates: Record<string, string> = {};
  for (const { o, d } of rows) {
    const sell = escrowCurrency(d);
    const locked = (d.policySnapshot as unknown as PolicySnapshot).lockRates[sell];
    const pair = `${sell}/${o.currency}`;
    if (sell === o.currency || !locked) continue;
    if (!lockedRates[pair] || BigInt(locked) > BigInt(lockedRates[pair]))
      lockedRates[pair] = locked;
  }
  return {
    policy: policy.resolved.policy,
    round,
    unfunded,
    lockedRates,
    deferralsLeft: treasury.maxDeferrals - held,
    reviewMoveBps: treasury.reviewMoveBps,
  };
}

/** How far each rate has moved against members since their funds were locked, in basis points. */
function adverseMoves(lockedRates: Record<string, string>, quotes: Quotes) {
  return Object.entries(lockedRates).flatMap(([pair, locked]) => {
    const now = quotes[pair]?.rateE8;
    if (now === undefined) return [];
    const base = BigInt(locked);
    return [
      {
        pair,
        lockedRateE8: locked,
        nowRateE8: now,
        adverseBps: Number(((base - now) * 10_000n) / base),
      },
    ];
  });
}

/**
 * Before a scheduled cycle, code works out what settling now would do. If everyone can pay and
 * rates are calm it just runs. If not, an agent chooses between plans that code has already built.
 */
async function treasuryHolds(tenantId: string, cycleId: string, group: string): Promise<boolean> {
  const key = { tenantId, cycleId, group };
  const view = await tx('treasury_view', (db) => treasuryView(db, key));
  if (!view) return false;
  const run = { ...key, rail: deps().rails.get(parseGroup(group).rail), policy: view.policy };
  const quotes: Quotes = {};
  const plan = await planRound(run, view.round, quotes);
  const fx = adverseMoves(view.lockedRates, quotes);
  const calm = fx.every((m) => m.adverseBps < view.reviewMoveBps);
  if (!view.unfunded.length && calm) return false;

  const atStake = mostAtStake(
    [...view.unfunded, ...view.round.debts, ...plan.uncovered],
    view.policy.decisions.ceiling,
  );
  const decision = await resolveCase({
    tenantId,
    kind: 'treasury_review',
    subjectType: 'group',
    subjectId: group,
    reason: view.unfunded.length
      ? `${view.unfunded.length} member(s) cannot yet fund this cycle`
      : 'Rates have moved against locked funds since these deals were agreed',
    evidence: {
      unfunded: view.unfunded,
      fx,
      conversions: plan.conversions,
      uncovered: plan.uncovered,
      obligations: view.round.count,
      deferralsLeft: view.deferralsLeft,
      options: {
        [PLAN_CONVERT_NOW]: 'Settle now',
        [PLAN_DEFER_CYCLE]: 'Hold this cycle for one interval',
      },
    },
    amount: atStake?.amount ?? 0n,
    currency: atStake?.currency ?? 'EUR',
    decisions: view.policy.decisions,
    planIds: [PLAN_CONVERT_NOW, PLAN_DEFER_CYCLE],
    skipPerson: true,
  });
  return (
    decision.outcome === 'decided' &&
    decision.action.type === 'choose_plan' &&
    decision.action.planId === PLAN_DEFER_CYCLE
  );
}

// ── FX ─────────────────────────────────────────────────────────────────────

type Quotes = Record<string, { rateE8: bigint; quoteId?: string }>;

/** Rates are taken once per pair and reused, so a re-net compares like with like. */
async function planRound(run: CycleRun, round: Round, quotes: Quotes): Promise<FxPlan> {
  for (const need of round.debts) {
    for (const c of round.collateral) {
      if (c.member !== need.member || c.currency === need.currency) continue;
      const pair = `${c.currency}/${need.currency}`;
      if (quotes[pair]) continue;
      const q = await networkStep('fx_quote', () => run.rail.quote(c.currency, need.currency));
      quotes[pair] = { rateE8: q.rateE8, quoteId: q.quoteId };
    }
  }
  return planFx(round.debts, round.collateral, (sell, buy) => quotes[`${sell}/${buy}`]?.rateE8);
}

/**
 * If the rate has moved so far that locked funds no longer cover what is owed, converting now
 * crystallises the loss. Code offers the options and a decider picks one. Default is to proceed.
 */
async function shouldDefer(
  run: CycleRun,
  attempt: number,
  round: Round,
  plan: FxPlan,
): Promise<boolean> {
  const short = plan.uncovered.filter((u) => round.collateral.some((c) => c.member === u.member));
  if (!short.length) return false;
  const atStake = mostAtStake(short, run.policy.decisions.ceiling) as FxNeed;
  const decision = await resolveCase(
    exceptionCase(
      run,
      `Locked funds no longer cover ${short.length} member(s) at the current rate`,
      {
        uncovered: short,
        options: {
          [PLAN_CONVERT_NOW]: 'Convert now and collect the difference from each member',
          [PLAN_DEFER_CYCLE]: 'Leave these obligations for the next cycle',
        },
        attempt,
      },
      {
        amount: atStake.amount,
        currency: atStake.currency,
        planIds: [PLAN_CONVERT_NOW, PLAN_DEFER_CYCLE],
      },
    ),
  );
  return (
    decision.outcome === 'decided' &&
    decision.action.type === 'choose_plan' &&
    decision.action.planId === PLAN_DEFER_CYCLE
  );
}

async function executeFx(run: CycleRun, attempt: number, plan: FxPlan, quotes: Quotes) {
  for (const c of plan.conversions) {
    const quote = quotes[`${c.sellCurrency}/${c.buyCurrency}`];
    await executeConversion(run, attempt, c, quote?.quoteId);
    // A quote can be used once. A later round in this cycle converts at the market rate.
    if (quote) quote.quoteId = undefined;
  }
  if (plan.exchanges.length) {
    await tx('fx_apply', (db) => applyExchanges(db, run, attempt, plan.exchanges));
  }
}

async function executeConversion(
  run: CycleRun,
  attempt: number | string,
  c: MarketConversion,
  quoteId: string | undefined,
) {
  const { rail, tenantId, cycleId } = run;
  const idempotencyKey = shortKey(`fx:${cycleId}:${attempt}:${c.sellCurrency}:${c.buyCurrency}`);
  const first = await networkStep('fx_convert', () =>
    rail.convert({ ...c, idempotencyKey, quoteId }),
  );
  const final: FxResult = await pollWhileSubmitted('fx_status', first, 200, (ref) =>
    rail.fxStatus(ref),
  );
  await tx('fx_record', async (db) => {
    await db
      .insert(fxConversions)
      .values({
        tenantId,
        cycleId,
        rail: rail.name,
        sellCurrency: c.sellCurrency,
        buyCurrency: c.buyCurrency,
        sellAmount: final.sellAmount,
        buyAmount: final.buyAmount,
        rateE8: final.rateE8,
        status: final.status,
        externalRef: final.externalRef,
        idempotencyKey,
      })
      .onConflictDoNothing();
    if (final.status !== 'confirmed') return;
    await deps().ledger.post(db, tenantId, [
      {
        key: `fx:${idempotencyKey}:buy`,
        debit: Accounts.houseCash(rail.name, c.buyCurrency),
        credit: Accounts.houseFx(c.buyCurrency),
        amount: final.buyAmount,
        kind: 'fx_buy',
        ref: cycleId,
      },
      {
        key: `fx:${idempotencyKey}:sell`,
        debit: Accounts.houseFx(c.sellCurrency),
        credit: Accounts.houseCash(rail.name, c.sellCurrency),
        amount: final.sellAmount,
        kind: 'fx_sell',
        ref: cycleId,
      },
    ]);
  });
  // Members must never be credited with money the house did not actually buy.
  if (final.status !== 'confirmed') {
    throw new Error(`Conversion ${final.externalRef} ended ${final.status}`);
  }
}

/** Move each member's foreign collateral into the currency it owes, through the house's FX position. */
async function applyExchanges(db: Tx, run: CycleRun, attempt: number, exchanges: MemberExchange[]) {
  const { ledger } = deps();
  const { tenantId, cycleId } = run;
  const rows = (await nettedRows(db, cycleId)).filter(({ o }) => o.leg === 'principal');

  const transfers: TransferInput[] = [];
  for (const e of exchanges) {
    let left = e.sellAmount;
    for (const { o, d } of rows) {
      if (left === 0n) break;
      if (o.payerMemberId !== e.member || escrowCurrency(d) !== e.sellCurrency) continue;
      const escrow = Accounts.dealEscrow(o.dealId, e.sellCurrency);
      const take = minBig(await ledger.balance(db, tenantId, escrow), left);
      if (take === 0n) continue;
      left -= take;
      transfers.push({
        key: `cycle:${cycleId}:${attempt}:fx:${o.id}:sell`,
        debit: escrow,
        credit: Accounts.houseFx(e.sellCurrency),
        amount: take,
        kind: 'fx_member_sell',
        ref: cycleId,
      });
    }
    transfers.push({
      key: `cycle:${cycleId}:${attempt}:fx:${e.member}:${e.sellCurrency}:${e.buyCurrency}:buy`,
      debit: Accounts.houseFx(e.buyCurrency),
      credit: Accounts.cycleSettlement(run.cycleId, e.member, e.buyCurrency),
      amount: e.buyAmount,
      kind: 'fx_member_buy',
      ref: cycleId,
    });
  }
  await ledger.post(db, tenantId, transfers);
}

// ── Funding net debtors ────────────────────────────────────────────────────

async function fundDebts(run: CycleRun, attempt: number, debts: Debt[]): Promise<Default[]> {
  const defaults: Default[] = [];
  for (const debt of debts) {
    const owed = await tx('remaining', (db) => remainingDebt(db, run, debt));
    if (owed === 0n) continue;
    const failure = await fundDebt(run, attempt, { ...debt, amount: owed });
    if (failure) defaults.push({ memberId: debt.member, reason: failure });
  }
  return defaults;
}

async function remainingDebt(db: Tx, run: CycleRun, debt: Debt): Promise<bigint> {
  const settlement = Accounts.cycleSettlement(run.cycleId, debt.member, debt.currency);
  const settled = await deps().ledger.balance(db, run.tenantId, settlement);
  return debt.target > settled ? debt.target - settled : 0n;
}

/** The wallet first, then pull if the rail can, then wait. Returns why it failed, if it did. */
async function fundDebt(run: CycleRun, attempt: number, debt: Debt): Promise<string | null> {
  let owed = await tx('cover_wallet', (db) => coverFromWallet(db, run, attempt, debt, 0));
  if (owed === 0n) return null;

  const ins = await tx('collect_open', (db) =>
    openInstruction(db, run, {
      memberId: debt.member,
      currency: debt.currency,
      direction: 'collect',
      amount: owed,
      rail: run.rail.name,
      attempt,
    }),
  );
  const result = await executeOnRail(run, ins);
  if (result.status === 'confirmed' || result.status === 'failed') {
    await tx('collect_result', (db) => applyResult(db, ins, result));
    if (result.status === 'confirmed') return null;
  }

  // Cannot pull, or the pull failed: give the member the funding window to send money in.
  const deadline = (await DBOS.now()) + durationMs(run.policy.settlement.fundingWindow);
  for (let i = 1; ; i++) {
    const now = await DBOS.now();
    if (now >= deadline) break;
    await DBOS.recv(Topics.funds, { deadlineEpochMS: Math.min(deadline, now + 300_000) });
    const remaining = { ...debt, amount: owed };
    owed = await tx('cover_wallet', (db) => coverFromWallet(db, run, attempt, remaining, i));
    if (owed === 0n) {
      await tx('collect_covered', (db) =>
        // No external reference: this money came through the wallet, not the rail.
        markInstruction(db, ins, {
          status: 'confirmed',
          failureReason: 'covered by deposit into the wallet',
          externalRef: null,
        }),
      );
      return null;
    }
  }
  const reason = result.reason ?? 'not funded in time';
  await tx('collect_failed', (db) =>
    markInstruction(db, ins, { status: 'failed', failureReason: reason }),
  );
  return reason;
}

async function coverFromWallet(
  db: Tx,
  run: CycleRun,
  attempt: number,
  debt: Debt,
  sequence: number,
): Promise<bigint> {
  const { ledger } = deps();
  const available = Accounts.memberAvailable(debt.member, debt.currency);
  const take = minBig(await ledger.balance(db, run.tenantId, available), debt.amount);
  if (take === 0n) return debt.amount;
  // A concurrent lock can spend the balance just read. That is a shortfall, not a failure.
  const posted = await tryPost(db, run.tenantId, [
    {
      key: `cycle:${run.cycleId}:${attempt}:wallet:${debt.member}:${debt.currency}:${sequence}`,
      debit: available,
      credit: Accounts.cycleSettlement(run.cycleId, debt.member, debt.currency),
      amount: take,
      kind: 'collection_from_wallet',
      ref: run.cycleId,
    },
  ]);
  return posted ? debt.amount - take : debt.amount;
}

const markInstruction = (
  db: Tx,
  ins: Instruction,
  change: Partial<Pick<Instruction, 'status' | 'failureReason' | 'externalRef'>>,
) => db.update(settlementInstructions).set(change).where(eq(settlementInstructions.id, ins.id));

const usesPortfolioMargin = (run: CycleRun) => run.policy.portfolioMargin?.mode === 'required';

/** Held in order, so two cycles or a margin release cannot read the same collateral at once. */
const lockMembers = (db: Tx, ids: string[]) =>
  db
    .select({ id: members.id })
    .from(members)
    .where(inArray(members.id, ids))
    .orderBy(asc(members.id))
    .for('update');

/** What collateral in the right currency will not cover, and what is held in other currencies. */
async function foreignMarginState(db: Tx, run: CycleRun, owed: Debt[]) {
  const held = (await memberHoldings(db, run.tenantId, 'portfolio_margin')).map((h) => ({
    member: h.memberId,
    currency: h.currency,
    amount: h.amount,
  }));
  const needs: FxNeed[] = [];
  for (const debt of owed) {
    const same = held.find((h) => h.member === debt.member && h.currency === debt.currency);
    const short = (await remainingDebt(db, run, debt)) - (same?.amount ?? 0n);
    if (short > 0n) needs.push({ member: debt.member, currency: debt.currency, amount: short });
  }
  const defaulters = new Set(owed.map((d) => d.member));
  const collateral = held.filter(
    (h) =>
      defaulters.has(h.member) &&
      !owed.some((d) => d.member === h.member && d.currency === h.currency),
  );
  return { needs, collateral };
}

const marginSaleKey = (run: CycleRun, attempt: number, e: MemberExchange) =>
  `cycle:${run.cycleId}:${attempt}:portfolio:${e.member}:${e.sellCurrency}:${e.buyCurrency}`;

/**
 * A defaulter's collateral in another currency has to be sold for what it owes. The sale comes off
 * the collateral before the market is touched, so nobody else can spend it in the meantime.
 */
async function sellPortfolioMargin(
  run: CycleRun,
  attempt: number,
  defaults: Default[],
  debts: Debt[],
): Promise<MemberExchange[]> {
  if (!usesPortfolioMargin(run)) return [];
  const ids = defaults.map((d) => d.memberId);
  const owed = debts.filter((d) => ids.includes(d.member));
  const state = await tx('margin_draw_state', (db) => foreignMarginState(db, run, owed));
  const quotes: Quotes = {};
  for (const need of state.needs) {
    for (const c of state.collateral) {
      if (c.member !== need.member) continue;
      const q = await networkStep('fx_quote', () => run.rail.quote(c.currency, need.currency));
      quotes[`${c.currency}/${need.currency}`] = { rateE8: q.rateE8, quoteId: q.quoteId };
    }
  }
  if (!Object.keys(quotes).length) return [];

  const plan = await tx('margin_draw_sell', async (db) => {
    await lockMembers(db, ids);
    const { needs, collateral } = await foreignMarginState(db, run, owed);
    const fresh = planFx(needs, collateral, (sell, buy) => quotes[`${sell}/${buy}`]?.rateE8);
    await deps().ledger.post(
      db,
      run.tenantId,
      fresh.exchanges.map((e) => ({
        key: `${marginSaleKey(run, attempt, e)}:sell`,
        debit: Accounts.memberPortfolioMargin(e.member, e.sellCurrency),
        credit: Accounts.houseFx(e.sellCurrency),
        amount: e.sellAmount,
        kind: 'default_portfolio_margin_sell',
        ref: run.cycleId,
      })),
    );
    return fresh;
  });
  try {
    for (const c of plan.conversions) {
      const { quoteId } = quotes[`${c.sellCurrency}/${c.buyCurrency}`] ?? {};
      await executeConversion(run, `${attempt}:margin`, c, quoteId);
    }
  } catch (err) {
    if (isWorkflowControl(err)) throw err;
    // The sale fell through, so the collateral goes back before the cycle stops.
    await tx('margin_draw_unsold', (db) =>
      deps().ledger.post(
        db,
        run.tenantId,
        plan.exchanges.map((e) => ({
          key: `${marginSaleKey(run, attempt, e)}:unsold`,
          debit: Accounts.houseFx(e.sellCurrency),
          credit: Accounts.memberPortfolioMargin(e.member, e.sellCurrency),
          amount: e.sellAmount,
          kind: 'default_portfolio_margin_unsold',
          ref: run.cycleId,
        })),
      ),
    );
    throw err;
  }
  return plan.exchanges;
}

/** Principal risk: the house pays creditors anyway. Defaulter's margin first, then the house. */
async function absorbDefaults(
  db: Tx,
  run: CycleRun,
  attempt: number,
  defaults: Default[],
  debts: Debt[],
  sold: MemberExchange[],
) {
  const { ledger } = deps();
  const { tenantId, cycleId } = run;
  const ids = defaults.map((d) => d.memberId);
  await lockMembers(db, ids);
  // In this transaction with the rest, so a cycle that stops first has taken no collateral.
  await ledger.post(
    db,
    tenantId,
    sold.map((e) => ({
      key: `${marginSaleKey(run, attempt, e)}:buy`,
      debit: Accounts.houseFx(e.buyCurrency),
      credit: Accounts.cycleSettlement(cycleId, e.member, e.buyCurrency),
      amount: e.buyAmount,
      kind: 'default_portfolio_margin_buy',
      ref: cycleId,
    })),
  );
  for (const debt of debts) {
    if (!ids.includes(debt.member)) continue;
    const settlement = Accounts.cycleSettlement(run.cycleId, debt.member, debt.currency);
    let short = debt.target - (await ledger.balance(db, tenantId, settlement));
    if (short <= 0n) continue;

    const open = await db
      .select()
      .from(deals)
      .where(
        and(
          eq(deals.tenantId, tenantId),
          eq(deals.sellerMemberId, debt.member),
          eq(deals.marginCurrency, debt.currency),
          notInArray(deals.status, ['settled', 'cancelled', 'rejected', 'refunded']),
        ),
      );
    const transfers: TransferInput[] = [];
    for (const d of open) {
      if (short === 0n) break;
      const account = Accounts.dealMargin(d.id, debt.currency);
      const take = minBig(await ledger.balance(db, tenantId, account), short);
      if (take === 0n) continue;
      short -= take;
      transfers.push({
        key: `cycle:${cycleId}:${attempt}:absorb:${d.id}`,
        debit: account,
        credit: settlement,
        amount: take,
        kind: 'default_margin_draw',
        ref: cycleId,
      });
    }
    const collateral = Accounts.memberPortfolioMargin(debt.member, debt.currency);
    const take = usesPortfolioMargin(run)
      ? minBig(await ledger.balance(db, tenantId, collateral), short)
      : 0n;
    if (take > 0n) {
      short -= take;
      transfers.push({
        key: `cycle:${cycleId}:${attempt}:portfolio:${debt.member}:${debt.currency}`,
        debit: collateral,
        credit: settlement,
        amount: take,
        kind: 'default_portfolio_margin',
        ref: cycleId,
      });
    }
    if (short > 0n && run.policy.risk.defaultFund) {
      const draws = await defaultFundDraws(db, run, attempt, debt, settlement, short);
      transfers.push(...draws.transfers);
      short = draws.short;
    }
    if (short > 0n) {
      transfers.push({
        key: `cycle:${cycleId}:${attempt}:loss:${debt.member}:${debt.currency}`,
        debit: Accounts.houseDefaultLoss(debt.currency),
        credit: settlement,
        amount: short,
        kind: 'default_loss',
        ref: cycleId,
      });
    }
    await ledger.post(db, tenantId, transfers);
  }
  await suspendMembers(db, run, ids);
}

/** The defaulter's own contribution first, then everyone else's in proportion to what they put in. */
async function defaultFundDraws(
  db: Tx,
  run: CycleRun,
  attempt: number,
  debt: Debt,
  settlement: AccountSpec,
  owed: bigint,
): Promise<{ transfers: TransferInput[]; short: bigint }> {
  const { tenantId, cycleId } = run;
  const funds = (await memberHoldings(db, tenantId, 'default_fund')).filter(
    (f) => f.currency === debt.currency,
  );
  const own = funds.filter((f) => f.memberId === debt.member);
  const others = funds.filter((f) => f.memberId !== debt.member);
  const pool = others.reduce((acc, f) => acc + f.amount, 0n);

  let short = owed;
  const transfers: TransferInput[] = [];
  const draw = (f: { memberId: string; amount: bigint }, wanted: bigint) => {
    const take = minBig(minBig(f.amount, wanted), short);
    if (take === 0n) return 0n;
    short -= take;
    transfers.push({
      key: `cycle:${cycleId}:${attempt}:fund:${debt.member}:${f.memberId}:${debt.currency}`,
      debit: Accounts.memberDefaultFund(f.memberId, debt.currency),
      credit: settlement,
      amount: take,
      kind: 'default_fund_draw',
      ref: cycleId,
    });
    return take;
  };
  for (const f of own) draw(f, f.amount);
  const toShare = short;
  for (const f of others) draw(f, mulDivUp(toShare, f.amount, pool));
  return { transfers, short };
}

const suspendMembers = (db: Tx, run: CycleRun, ids: string[]) =>
  db
    .update(members)
    .set({ status: 'suspended' })
    .where(and(eq(members.tenantId, run.tenantId), inArray(members.id, ids)));

/** Send a cycle's obligations back to the queue, a whole deal at a time. */
async function requeue(db: Tx, cycleId: string, event: string, onlyMembers?: string[]) {
  const rows = await db
    .select({ dealId: obligations.dealId })
    .from(obligations)
    .where(
      and(
        eq(obligations.cycleId, cycleId),
        eq(obligations.status, 'netted'),
        onlyMembers
          ? or(
              inArray(obligations.payerMemberId, onlyMembers),
              inArray(obligations.payeeMemberId, onlyMembers),
            )
          : undefined,
      ),
    );
  const dealIds = [...new Set(rows.map((r) => r.dealId))];
  if (!dealIds.length) return;
  await db
    .update(obligations)
    .set({ status: 'eligible', cycleId: null })
    .where(and(eq(obligations.cycleId, cycleId), inArray(obligations.dealId, dealIds)));
  await db.update(deals).set({ status: 'eligible' }).where(inArray(deals.id, dealIds));
  for (const id of dealIds) await record(db, id, event, { cycleId, members: onlyMembers });
}

/** Each member's position in a cycle. These accounts exist only for that cycle. */
async function cyclePositions(db: Tx, tenantId: string, cycleId: string) {
  const accounts = await deps().ledger.balances(db, tenantId, `cycle:${cycleId}:`);
  return accounts.map((a) => ({
    memberId: a.code.split(':')[2] as string,
    currency: a.currency,
    balance: a.balance,
  }));
}

/** A cycle that will not commit gives back whatever it already collected. */
async function returnCollected(db: Tx, tenantId: string, cycleId: string) {
  const transfers: TransferInput[] = [];
  for (const { memberId, currency, balance } of await cyclePositions(db, tenantId, cycleId)) {
    if (balance <= 0n) continue;
    transfers.push({
      key: `cycle:${cycleId}:returned:${memberId}:${currency}`,
      debit: Accounts.cycleSettlement(cycleId, memberId, currency),
      credit: Accounts.memberAvailable(memberId, currency),
      amount: balance,
      kind: 'collection_returned',
      ref: cycleId,
    });
  }
  await deps().ledger.post(db, tenantId, transfers);
}

/** Agent risk: a defaulter's obligations return to the queue, and the rest re-net without them. */
async function excludeMembers(db: Tx, run: CycleRun, ids: string[]) {
  await suspendMembers(db, run, ids);
  await requeue(db, run.cycleId, 'deferred_by_default', ids);
}

async function deferCycle(db: Tx, run: CycleRun) {
  await returnCollected(db, run.tenantId, run.cycleId);
  await requeue(db, run.cycleId, 'deferred_by_decision');
  await db
    .update(cycles)
    .set({ status: 'deferred', closedAt: new Date() })
    .where(eq(cycles.id, run.cycleId));
}

// ── Commit and pay ─────────────────────────────────────────────────────────

/** All funding is in, so novate the obligations and read what is owed straight from the ledger. */
async function commit(db: Tx, run: CycleRun) {
  const { ledger } = deps();
  const { tenantId, cycleId } = run;
  const rows = await nettedRows(db, cycleId);
  const transfers: TransferInput[] = [];

  for (const { o, d } of rows) {
    const payer = Accounts.cycleSettlement(run.cycleId, o.payerMemberId, o.currency);
    const payee = Accounts.cycleSettlement(run.cycleId, o.payeeMemberId, o.currency);
    const clearing = Accounts.houseClearing(o.currency);
    const key = `cycle:${cycleId}:obligation:${o.id}`;
    if (o.leg === 'principal') {
      const currency = escrowCurrency(d);
      const escrow = Accounts.dealEscrow(o.dealId, currency);
      const held = await ledger.balance(db, tenantId, escrow);
      const prefunded = currency === o.currency ? minBig(held, o.amount) : 0n;
      if (prefunded > 0n) {
        transfers.push({
          key: `${key}:prefund`,
          debit: escrow,
          credit: payer,
          amount: prefunded,
          kind: 'escrow_apply',
          ref: o.dealId,
        });
      } else if (currency !== o.currency && held > 0n) {
        // Whatever was not converted, the FX buffer included, goes back to the buyer.
        transfers.push({
          key: `${key}:collateral_return`,
          debit: escrow,
          credit: Accounts.memberAvailable(o.payerMemberId, currency),
          amount: held,
          kind: 'escrow_refund',
          ref: o.dealId,
        });
      }
    }
    transfers.push({
      key: `${key}:payer`,
      debit: payer,
      credit: clearing,
      amount: o.amount,
      kind: 'novation',
      ref: o.dealId,
    });
    transfers.push({
      key: `${key}:payee`,
      debit: clearing,
      credit: payee,
      amount: o.amount,
      kind: 'novation',
      ref: o.dealId,
    });
  }
  if (transfers.length) await ledger.post(db, tenantId, transfers);
  await db.update(cycles).set({ status: 'committed' }).where(eq(cycles.id, cycleId));

  const walletMembers = new Set(
    (
      await db
        .select({ id: members.id, attributes: members.attributes })
        .from(members)
        .where(eq(members.tenantId, tenantId))
    )
      .filter((m) => (m.attributes as { payout?: string }).payout === 'wallet')
      .map((m) => m.id),
  );

  const instructions: Instruction[] = [];
  // Read from the ledger, so a member collected in an earlier round and later excluded is repaid.
  for (const { memberId, currency, balance } of await cyclePositions(db, tenantId, cycleId)) {
    if (balance <= 0n) continue;
    instructions.push(
      await openInstruction(db, run, {
        memberId,
        currency,
        direction: 'payout',
        amount: balance,
        rail: walletMembers.has(memberId) ? WALLET_RAIL : run.rail.name,
        attempt: 0,
      }),
    );
  }
  return { count: rows.length, instructions };
}

async function openInstruction(
  db: Tx,
  run: PayoutRun,
  v: Pick<Instruction, 'memberId' | 'currency' | 'direction' | 'amount' | 'rail' | 'attempt'>,
): Promise<Instruction> {
  const idempotencyKey = shortKey(
    `${run.cycleId}:${v.rail}:${v.memberId}:${v.currency}:${v.direction}:${v.attempt}`,
  );
  const [row] = await db
    .insert(settlementInstructions)
    .values({ ...v, tenantId: run.tenantId, cycleId: run.cycleId, idempotencyKey })
    .onConflictDoUpdate({
      target: settlementInstructions.idempotencyKey,
      set: { updatedAt: new Date() },
    })
    .returning();
  return row as Instruction;
}

/** Pay one creditor. A failure never touches the member: it retries, then credits their wallet. */
async function payOut(run: PayoutRun, first: Instruction) {
  const { tenantId } = run;
  if (first.rail === WALLET_RAIL) {
    await tx('wallet_credit', (db) =>
      applyResult(db, first, { status: 'confirmed', externalRef: `wallet:${first.id}` }),
    );
    return;
  }
  let ins = first;
  for (let attempt = 0; ; attempt++) {
    const current = ins;
    const reserved = await tx('reserve_payout', (db) =>
      tryPost(db, tenantId, [reservation(current)]),
    );
    const result: RailResult = reserved
      ? await executeOnRail(run, current)
      : {
          status: 'failed',
          externalRef: `nofunds:${current.id}`,
          reason: 'house cash on this rail is short',
        };
    await tx('payout_result', async (db) => {
      await applyResult(db, current, result);
      if (reserved && result.status !== 'confirmed') {
        await deps().ledger.post(db, tenantId, [releaseReservation(current)]);
      }
    });
    if (result.status === 'confirmed') return;

    const decision = await resolveCase(
      exceptionCase(
        run,
        `Payout to ${current.memberId} failed: ${result.reason ?? 'unknown'}`,
        {
          memberId: current.memberId,
          amount: current.amount.toString(),
          currency: current.currency,
          reason: result.reason,
          attempt,
          retriesLeft: MAX_RETRIES - attempt,
        },
        {
          amount: current.amount,
          currency: current.currency,
          memberIds: [current.memberId],
          attemptsLeft: MAX_RETRIES - attempt,
          ruleVars: { attempt: BigInt(attempt) },
        },
      ),
    );
    if (!wantsRetry(decision, attempt)) {
      // The house still owes this money, so it stays with the member as a balance they can withdraw.
      await tx('payout_to_wallet', (db) =>
        deps().ledger.post(db, tenantId, [
          {
            key: `instruction:${current.id}:fallback`,
            debit: Accounts.cycleSettlement(run.cycleId, current.memberId, current.currency),
            credit: Accounts.memberAvailable(current.memberId, current.currency),
            amount: current.amount,
            kind: 'payout_fallback_wallet',
            ref: run.cycleId,
          },
        ]),
      );
      return;
    }
    ins = await tx('payout_retry', (db) =>
      openInstruction(db, run, {
        memberId: current.memberId,
        currency: current.currency,
        direction: current.direction,
        amount: current.amount,
        rail: current.rail,
        attempt: attempt + 1,
      }),
    );
  }
}

/**
 * Submit and wait. An unanswered payment is never treated as failed: it might have been sent. It
 * waits on webhooks and polls, and is flagged `in_doubt` once it runs past the confirm window.
 */
async function executeOnRail(run: PayoutRun, ins: Instruction): Promise<RailResult> {
  const { rail, policy } = run;
  const member = await tx('rail_member', (db) => getMember(db, ins.memberId));
  const req = {
    idempotencyKey: ins.idempotencyKey,
    member: { id: member.id, railRefs: member.railRefs },
    currency: ins.currency,
    amount: ins.amount,
    reference: `novate cycle ${ins.cycleId.slice(0, 8)}`,
  };
  const confirmBy = (await DBOS.now()) + durationMs(policy.settlement.confirmWithin);

  let result: RailResult | undefined;
  for (let i = 0; !result; i++) {
    try {
      result = await networkStep(`rail_${ins.direction}`, () =>
        ins.direction === 'collect' ? rail.collect(req) : rail.payout(req),
      );
    } catch (err) {
      if (isWorkflowControl(err)) throw err;
      if ((await DBOS.now()) > confirmBy) await flagInDoubt(ins);
      await DBOS.sleep(Math.min(300_000, 5_000 * 2 ** i));
    }
  }
  if (result.status !== 'submitted') return result;

  const { externalRef } = result;
  await tx('rail_submitted', (db) =>
    db
      .update(settlementInstructions)
      .set({ status: 'submitted', externalRef })
      .where(eq(settlementInstructions.id, ins.id)),
  );

  let flagged = false;
  for (let i = 0; ; i++) {
    await DBOS.recv(Topics.rail, { timeoutSeconds: Math.min(300, 2 ** Math.min(i, 8) / 2) });
    const polled = await networkStep('rail_status', () =>
      rail.status(externalRef, ins.direction),
    ).catch((err: unknown): RailResult => {
      if (isWorkflowControl(err)) throw err;
      return { status: 'submitted', externalRef };
    });
    if (polled.status !== 'submitted') return polled;
    if (!flagged && (await DBOS.now()) > confirmBy) {
      flagged = true;
      await flagInDoubt(ins);
    }
  }
}

const flagInDoubt = (ins: Instruction) =>
  tx('flag_in_doubt', (db) => markInstruction(db, ins, { status: 'in_doubt' }));

const instructionStatus = (result: RailResult): Instruction['status'] =>
  result.status === 'confirmed' || result.status === 'failed' ? result.status : 'submitted';

/** Set the money aside before it is sent, so concurrent cycles cannot both spend it. */
const reservation = (ins: Instruction): TransferInput => ({
  key: `instruction:${ins.id}:reserve`,
  debit: Accounts.houseInFlight(ins.rail, ins.currency),
  credit: Accounts.houseCash(ins.rail, ins.currency),
  amount: ins.amount,
  kind: 'payout_reserve',
  ref: ins.cycleId,
});

const releaseReservation = (ins: Instruction): TransferInput => ({
  key: `instruction:${ins.id}:release`,
  debit: Accounts.houseCash(ins.rail, ins.currency),
  credit: Accounts.houseInFlight(ins.rail, ins.currency),
  amount: ins.amount,
  kind: 'payout_release',
  ref: ins.cycleId,
});

function settlementTransfer(ins: Instruction): TransferInput {
  const settlement = Accounts.cycleSettlement(ins.cycleId, ins.memberId, ins.currency);
  const base = { key: `instruction:${ins.id}`, amount: ins.amount, ref: ins.cycleId };
  if (ins.direction === 'collect') {
    const cash = Accounts.houseCash(ins.rail, ins.currency);
    return { ...base, debit: cash, credit: settlement, kind: 'collection' };
  }
  if (ins.rail === WALLET_RAIL) {
    const wallet = Accounts.memberAvailable(ins.memberId, ins.currency);
    return { ...base, debit: settlement, credit: wallet, kind: 'wallet_credit' };
  }
  const inFlight = Accounts.houseInFlight(ins.rail, ins.currency);
  return { ...base, debit: settlement, credit: inFlight, kind: 'payout' };
}

async function applyResult(db: Tx, ins: Instruction, result: RailResult) {
  await db
    .update(settlementInstructions)
    .set({
      status: instructionStatus(result),
      externalRef: result.externalRef,
      failureReason: result.reason ?? null,
    })
    .where(eq(settlementInstructions.id, ins.id));
  if (result.status === 'confirmed') {
    await deps().ledger.post(db, ins.tenantId, [settlementTransfer(ins)]);
  }
}

async function closeCycle(
  db: Tx,
  run: Pick<PayoutRun, 'tenantId' | 'cycleId'>,
  totals: Totals,
  status: 'settled' | 'failed',
  failures: CycleSummary['failures'],
): Promise<string[]> {
  const { tenantId, cycleId } = run;
  const netted = await db
    .select()
    .from(obligations)
    .where(and(eq(obligations.cycleId, cycleId), eq(obligations.status, 'netted')));
  for (const p of await cyclePositions(db, tenantId, cycleId)) {
    if (p.balance !== 0n) {
      throw new Error(
        `Cycle ${cycleId} does not balance: ${p.memberId} ${p.currency} = ${p.balance}`,
      );
    }
  }
  await db
    .update(obligations)
    .set({ status: 'settled' })
    .where(and(eq(obligations.cycleId, cycleId), eq(obligations.status, 'netted')));
  await db
    .update(cycles)
    .set({
      status,
      closedAt: new Date(),
      summary: { obligations: netted.length, totals, failures },
    })
    .where(eq(cycles.id, cycleId));
  return [...new Set(netted.map((o) => o.dealId))];
}

// ── Withdrawals ────────────────────────────────────────────────────────────

export const WITHDRAWAL_OPENED = 'withdrawal_opened';

export interface WithdrawalRequest {
  memberId: string;
  currency: string;
  amount: bigint;
}

/** Take the money from the wallet, or say why not. Owing anything comes before taking money out. */
async function openWithdrawal(
  db: Tx,
  run: PayoutRun,
  { memberId, currency, amount }: WithdrawalRequest,
): Promise<Instruction | string> {
  const { ledger } = deps();
  const { tenantId, cycleId } = run;
  const member = await getMember(db, memberId);
  if (member.status !== 'active') return `member is ${member.status}`;
  const [call] = await db
    .select({ id: marginCalls.id })
    .from(marginCalls)
    .where(and(eq(marginCalls.memberId, memberId), eq(marginCalls.status, 'open')));
  if (call) return 'a margin call is open';
  const debt = await ledger.balance(db, tenantId, Accounts.memberDebt(memberId, currency));
  if (debt < 0n) return 'the member owes the house money in this currency';

  const taken = await tryPost(db, tenantId, [
    {
      key: `withdrawal:${cycleId}`,
      debit: Accounts.memberAvailable(memberId, currency),
      credit: Accounts.cycleSettlement(cycleId, memberId, currency),
      amount,
      kind: 'withdrawal',
      ref: cycleId,
    },
  ]);
  if (!taken) return 'not enough available';
  await db
    .insert(cycles)
    .values({ id: cycleId, tenantId, settlementGroup: 'withdrawal', status: 'committed' });
  return openInstruction(db, run, {
    memberId,
    currency,
    direction: 'payout',
    amount,
    rail: run.rail.name,
    attempt: 0,
  });
}

/**
 * A withdrawal is a one-payment cycle, so it shares every safeguard of a payout: the cash is
 * reserved, an unanswered payment is never assumed failed, and a failure lands back in the wallet.
 */
async function runWithdrawal(
  tenantId: string,
  cycleId: string,
  railName: string,
  request: WithdrawalRequest,
): Promise<void> {
  try {
    const policy = await tx('withdrawal_terms', async (db) => ({
      decisions: await strictestDecisions(db, tenantId, request.currency),
      settlement: Settlement.parse({ rail: railName }),
    }));
    const run: PayoutRun = { tenantId, cycleId, rail: deps().rails.get(railName), policy };
    const opened = await tx('withdrawal_open', (db) => openWithdrawal(db, run, request));
    const refused = typeof opened === 'string' ? opened : undefined;
    await DBOS.setEvent(WITHDRAWAL_OPENED, { refused });
    if (typeof opened === 'string') return;
    await payOut(run, opened);
    await tx('withdrawal_close', (db) => closeCycle(db, run, {}, 'settled', []));
  } catch (err) {
    if (isWorkflowControl(err)) throw err;
    await failSafe(tenantId, cycleId, err as Error);
  }
}

export const withdrawalWorkflow = DBOS.registerWorkflow(runWithdrawal, { name: 'withdrawal' });
