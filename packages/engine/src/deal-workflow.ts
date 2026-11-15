import { DBOS } from '@dbos-inc/dbos-sdk';
import {
  applyBps,
  type DealLine,
  DealTerms,
  DomainError,
  dealAmount,
  dealQuantity,
  fxSellAmount,
  minBig,
  mulDivUp,
} from '@novate/core';
import { dealEvents, dealFacts, deals, obligations, type Tx } from '@novate/db';
import { Accounts, type TransferInput } from '@novate/ledger';
import {
  type ConditionContext,
  type ConditionResult,
  durationMs,
  evaluateCondition,
  type Finding,
  type Funding,
  findingsReason,
  type Margin,
  ProgramSpec,
  type ResolvedPolicy,
  releaseAmount,
} from '@novate/policy';
import type { RailResult, SettlementRail } from '@novate/rails';
import type { SignalReading } from '@novate/signals';
import { and, desc, eq } from 'drizzle-orm';
import { checkAuthority } from './authority.ts';
import { cycleWorkflow } from './cycle-workflow.ts';
import { railRefusal, resolveForDeal, shapeProblem, signalSubject } from './deal-policy.ts';
import { type CaseSpec, dealCase, resolveCase } from './decisions.ts';
import { deps, isWorkflowControl, networkStep, pollWhileSubmitted, tryPost, tx } from './deps.ts';
import { deposit } from './funds.ts';
import { notify } from './notifications.ts';
import { assessMembers, marginCoversDeal } from './portfolio-margin.ts';
import { impliedRateE8, rateLabel, rateString } from './rates.ts';
import {
  type DealRow,
  escrowCurrency,
  getDeal,
  getMember,
  getProgram,
  listFacts,
  loadProgramSpec,
  type PolicySnapshot,
  type ProgramRow,
  record,
  setStatus,
  signalValues,
  snapshotOf,
} from './repo.ts';
import { settlementGroup, shortKey, stableUuid } from './settlement-group.ts';
import { Topics } from './topics.ts';

const MAX_REPRICES = 3;

interface LoadedProgram {
  row: ProgramRow;
  spec: ProgramSpec;
}

type Terminal = 'rejected' | 'cancelled' | 'refunded' | 'settled' | 'exception';
type LockKind = 'escrow' | 'margin';

export type SettlementMessage =
  | { type: 'settled'; cycleId: string }
  | { type: 'cure_expired'; sellerAtFault: boolean };

/**
 * The life of one deal, from submission to settlement. Durable: every step is checkpointed in
 * Postgres, so a crash at any point resumes exactly where it stopped. What happens at each stage
 * is decided by the deal's resolved policy, never hard-coded here.
 */
async function dealLifecycle(dealId: string): Promise<Terminal> {
  try {
    return await runDeal(dealId);
  } catch (err) {
    if (isWorkflowControl(err)) throw err;
    return handleException(dealId, err as Error);
  }
}

export const dealWorkflow = DBOS.registerWorkflow(dealLifecycle, { name: 'dealLifecycle' });

async function runDeal(dealId: string): Promise<Terminal> {
  const start = await DBOS.now();
  const { submitted, program } = await tx('load', async (db) => {
    const submitted = await getDeal(db, dealId);
    const row = await getProgram(db, submitted.programId);
    return { submitted, program: { row, spec: ProgramSpec.parse(row.spec) } };
  });

  const authorised = await authorise(submitted, program, start);
  if (typeof authorised === 'string') return authorised;
  const { resolved } = authorised;
  const clearing = resolved.policy.settlement.mode === 'clear';

  // From here the deal's terms, currencies and policy are fixed, so this row stays valid.
  const deal = clearing ? await planLocks(authorised.deal, resolved) : authorised.deal;
  if (clearing && resolved.policy.portfolioMargin?.mode === 'required') {
    if (!(await marginCoversDeal(deal))) {
      const outcome = await cancel(deal, 'portfolio margin does not cover this position');
      // The call this deal just raised has gone with it.
      await assessMembers(deal.tenantId, [deal.buyerMemberId, deal.sellerMemberId]);
      return outcome;
    }
  }
  if (clearing) {
    const funded = await fundDeal(deal, resolved);
    if (funded !== 'funded') return funded;
  }

  const release = await awaitRelease(deal, resolved, start);
  if (release.outcome !== 'release') return release.outcome;

  if (!clearing) {
    await tx('verified', (db) => setStatus(db, deal.id, 'settled', { type: 'verified' }, null));
    return 'settled';
  }

  const releasedAt = await DBOS.now();
  const released = await tx('release', (db) =>
    releaseFunds(db, deal, releasedAt, release.forcedBps),
  );
  if (released === 0n) {
    await tx('unwind', (db) => unwind(db, deal, 'refunded', 'nothing to release', true));
    return 'refunded';
  }
  if (released < deal.amount) {
    await notifySeller(deal, released, 'reduced', 'Only part of the deal was released');
  }

  if (resolved.policy.settlement.timing.mode === 'immediate') {
    const cycleId = stableUuid(`immediate:${deal.id}`);
    const group = settlementGroup(deal, resolved.policy.settlement);
    await DBOS.startWorkflow(cycleWorkflow, { workflowID: cycleId })(deal.tenantId, cycleId, group);
  }

  // Wait for the cycle that settles this obligation, then return the seller's margin.
  while (true) {
    const msg = await DBOS.recv<SettlementMessage>(Topics.settled, { timeoutSeconds: 86_400 });
    if (msg?.type === 'settled') {
      await tx('settled', (db) => completeDeal(db, deal, msg.cycleId, released));
      return 'settled';
    }
    if (msg?.type === 'cure_expired') {
      const refunded = await tx('cure_refund', (db) => refundUncured(db, deal, msg.sellerAtFault));
      if (refunded) return 'refunded';
    }
  }
}

/** Anything unexpected parks the deal, funds intact, and raises a case. It never strands silently. */
async function handleException(dealId: string, err: Error): Promise<Terminal> {
  // Parties can read this, so the raw error, which may hold query text, stays in the logs.
  console.error(`Deal ${dealId} stopped:`, err);
  const reason =
    err instanceof DomainError ? err.message.slice(0, 500) : 'Unexpected internal error';
  const { deal, decisions } = await tx('exception_park', async (db) => {
    const deal = await getDeal(db, dealId);
    await setStatus(db, dealId, 'exception', { type: 'exception', payload: { reason } }, reason);
    return { deal, decisions: (await loadProgramSpec(db, deal)).decisions };
  });
  const res = await resolveCase(dealCase(deal, decisions, 'exception', reason, { error: reason }));
  if (res.outcome === 'decided' && res.action.type === 'refund') {
    await tx('exception_refund', (db) => unwind(db, deal, 'refunded', reason, false));
    return 'refunded';
  }
  return 'exception';
}

// ── Authority, policy and mistake checks ───────────────────────────────────

/** A reprice changes the deal, so every check runs again until it passes or something stops it. */
async function authorise(
  first: DealRow,
  program: LoadedProgram,
  start: number,
): Promise<{ deal: DealRow; resolved: ResolvedPolicy } | Terminal> {
  let deal = first;
  for (let round = 0; ; round++) {
    const current = deal;
    const authority = await tx('authority', (db) =>
      checkAuthority(db, current, program.spec, new Date(start)),
    );
    if (authority.length) return reject(deal, 'authority_failed', { authority }, authority);

    const signals = await DBOS.runStep(
      () => deps().signals.resolve(program.spec.signals, signalSubject(current)),
      { name: 'signals' },
    );
    const snapshotted = await tx('resolve', (db) =>
      resolveAndSnapshot(db, current, program, signals, new Date(start)),
    );
    deal = snapshotted.deal;
    const { resolved } = snapshotted;

    // Checked here too, because a program override can change the rail per deal.
    const railProblem = railRefusal(deal.tenantId, resolved.policy.settlement.rail);
    if (railProblem) return reject(deal, 'authority_failed', { rail: railProblem }, [railProblem]);

    if (resolved.authorityFailures.length) {
      const rules = resolved.authorityFailures;
      return reject(deal, 'authority_failed', { rules }, rules);
    }
    const rejects = resolved.checks.filter((c) => c.action === 'reject');
    if (rejects.length) {
      const reasons = rejects.map((c) => c.reason);
      return reject(deal, 'check_rejected', { checks: rejects }, reasons);
    }
    const freezes = resolved.checks.filter((c) => c.action === 'freeze');
    if (!freezes.length) return { deal, resolved };

    const frozen = deal;
    const reason = freezes.map((c) => c.reason).join('; ');
    await tx('frozen', (db) =>
      setStatus(db, frozen.id, 'frozen', { type: 'frozen', payload: { reason } }, reason),
    );
    const decisions = resolved.policy.decisions;
    const res = await resolveCase(
      dealCase(frozen, decisions, 'frozen', reason, {
        checks: freezes,
        signals: signalValues(signals),
      }),
    );
    if (res.outcome === 'stale') continue;
    if (res.outcome === 'expired') {
      if (decisions.onTimeout === 'proceed') return { deal, resolved };
      return cancel(deal, 'review timed out');
    }
    if (res.action.type === 'confirm') return { deal, resolved };
    if (res.action.type === 'reprice' && round < MAX_REPRICES) {
      const { lines } = res.action;
      const shape = shapeProblem(program.spec, { ...DealTerms.parse(frozen.terms), lines });
      if (shape) return cancel(deal, shape);
      deal = await tx('reprice', (db) => repriceDeal(db, frozen, lines));
      continue;
    }
    return cancel(deal, `cancelled by ${res.decider.type}`);
  }
}

async function reject(
  deal: DealRow,
  type: 'authority_failed' | 'check_rejected',
  payload: Record<string, unknown>,
  reasons: string[],
): Promise<Terminal> {
  await tx('reject', (db) =>
    setStatus(db, deal.id, 'rejected', { type, payload }, reasons.join('; ')),
  );
  return 'rejected';
}

async function cancel(deal: DealRow, reason: string): Promise<Terminal> {
  await tx('cancel', (db) =>
    setStatus(db, deal.id, 'cancelled', { type: 'cancelled', payload: { reason } }, reason),
  );
  return 'cancelled';
}

async function resolveAndSnapshot(
  db: Tx,
  deal: DealRow,
  program: LoadedProgram,
  signals: Record<string, SignalReading>,
  now: Date,
): Promise<{ deal: DealRow; resolved: ResolvedPolicy }> {
  const resolved = await resolveForDeal(db, deal, program.spec, signals);
  const snapshot: PolicySnapshot = {
    programId: program.row.id,
    programVersion: program.row.version,
    resolved,
    signals,
    authorisedAt: now.toISOString(),
    lockRates: {},
  };
  const updated = await saveSnapshot(db, deal, snapshot);
  await setStatus(db, deal.id, 'authorised', {
    type: 'policy_resolved',
    payload: {
      program: `${program.row.key}@v${program.row.version}`,
      fundingBps: resolved.fundingBps,
      marginBps: resolved.marginBps,
      overrides: resolved.overridesApplied,
      checks: resolved.checks,
    },
  });
  return { deal: updated, resolved };
}

async function saveSnapshot(
  db: Tx,
  deal: DealRow,
  snapshot: PolicySnapshot,
  extra: Partial<DealRow> = {},
): Promise<DealRow> {
  const [row] = await db
    .update(deals)
    .set({ ...extra, policySnapshot: snapshot as unknown as Record<string, unknown> })
    .where(eq(deals.id, deal.id))
    .returning();
  return row as DealRow;
}

async function repriceDeal(db: Tx, deal: DealRow, lines: DealLine[]): Promise<DealRow> {
  const amount = dealAmount({ lines });
  const [row] = await db
    .update(deals)
    .set({
      terms: { ...deal.terms, lines },
      amount,
      quantity: dealQuantity({ lines }),
      authorityPassedAt: null,
    })
    .where(eq(deals.id, deal.id))
    .returning();
  await record(db, deal.id, 'repriced', { from: deal.amount, to: amount, currency: deal.currency });
  return row as DealRow;
}

// ── Funding and margin ─────────────────────────────────────────────────────

const railOf = (resolved: ResolvedPolicy): SettlementRail =>
  deps().rails.get(resolved.policy.settlement.rail);

/** Decide which currencies to lock in, and record the rate that sizes each lock. */
async function planLocks(deal: DealRow, resolved: ResolvedPolicy): Promise<DealRow> {
  const { buyerHome, sellerHome } = await tx('lock_parties', async (db) => ({
    buyerHome: (await getMember(db, deal.buyerMemberId)).homeCurrency,
    sellerHome: (await getMember(db, deal.sellerMemberId)).homeCurrency,
  }));
  const { funding } = resolved.policy;
  const home = funding.mode !== 'net_then_fund' && funding.currency === 'home';
  const plan = {
    fundingCurrency: home ? buyerHome : deal.currency,
    marginCurrency: home ? sellerHome : deal.currency,
  };
  const rail = railOf(resolved);
  const lockRates: Record<string, string> = {};
  for (const currency of new Set([plan.fundingCurrency, plan.marginCurrency])) {
    if (currency === deal.currency) continue;
    const quote = await networkStep('lock_rate', () => rail.quote(currency, deal.currency));
    lockRates[currency] = quote.rateE8.toString();
  }
  return tx('lock_plan', async (db) => {
    const updated = await saveSnapshot(db, deal, { ...snapshotOf(deal), lockRates }, plan);
    await db
      .insert(obligations)
      .values({
        tenantId: deal.tenantId,
        dealId: deal.id,
        payerMemberId: deal.buyerMemberId,
        payeeMemberId: deal.sellerMemberId,
        currency: deal.currency,
        amount: deal.amount,
        settlementGroup: settlementGroup(deal, resolved.policy.settlement),
      })
      .onConflictDoNothing();
    await record(db, deal.id, 'locks_planned', { ...plan, lockRates });
    return updated;
  });
}

async function fundDeal(deal: DealRow, resolved: ResolvedPolicy): Promise<'funded' | Terminal> {
  const { funding, margin } = resolved.policy;
  const funded = await lockWithWait(deal, resolved, 'escrow', resolved.fundingBps, funding);
  const margined =
    funded && (await lockWithWait(deal, resolved, 'margin', resolved.marginBps, margin));
  if (funded && margined) return 'funded';
  const reason = funded ? 'seller margin not posted in time' : 'buyer funding not received in time';
  await tx('unwind', (db) => unwind(db, deal, 'cancelled', reason, false));
  return 'cancelled';
}

const lockCurrency = (deal: DealRow, kind: LockKind) =>
  kind === 'escrow' ? escrowCurrency(deal) : (deal.marginCurrency ?? deal.currency);

const lockAccount = (deal: DealRow, kind: LockKind, currency = lockCurrency(deal, kind)) =>
  kind === 'escrow'
    ? Accounts.dealEscrow(deal.id, currency)
    : Accounts.dealMargin(deal.id, currency);

const lockOwner = (deal: DealRow, kind: LockKind) =>
  kind === 'escrow' ? deal.buyerMemberId : deal.sellerMemberId;

/** Express an amount in the deal's currency in the currency a lock is held in, rounding up. */
function inLockCurrency(deal: DealRow, amount: bigint, currency: string): bigint {
  if (currency === deal.currency) return amount;
  const rate = BigInt(snapshotOf(deal).lockRates[currency] as string);
  return fxSellAmount(amount, rate, currency, deal.currency);
}

function lockAmount(deal: DealRow, kind: LockKind, bps: number): bigint {
  const currency = lockCurrency(deal, kind);
  const converted = inLockCurrency(deal, applyBps(deal.amount, bps), currency);
  if (currency === deal.currency) return converted;
  const { funding } = snapshotOf(deal).resolved.policy;
  const buffer = 'fxBufferBps' in funding ? funding.fxBufferBps : 0;
  return applyBps(converted, 10_000 + buffer);
}

/**
 * How a lock held in another currency was sized, both rates as units of the deal's currency per 1
 * of the lock's: `marketRate` as quoted, `rate` after the FX buffer, which is what the member paid.
 */
function lockFx(deal: DealRow, kind: LockKind, bps: number) {
  const currency = lockCurrency(deal, kind);
  if (currency === deal.currency) return {};
  const market = BigInt(snapshotOf(deal).lockRates[currency] as string);
  const { funding } = snapshotOf(deal).resolved.policy;
  const effective =
    impliedRateE8(
      lockAmount(deal, kind, bps),
      currency,
      applyBps(deal.amount, bps),
      deal.currency,
    ) ?? market;
  return {
    dealCurrency: deal.currency,
    rate: rateString(effective),
    rateLabel: rateLabel(currency, deal.currency, effective),
    marketRate: rateString(market),
    bufferBps: 'fxBufferBps' in funding ? funding.fxBufferBps : 0,
  };
}

/** Lock `bps` of the deal from the buyer (escrow) or seller (margin), waiting for deposits. */
async function lockWithWait(
  deal: DealRow,
  resolved: ResolvedPolicy,
  kind: LockKind,
  bps: number,
  cfg: Funding | Margin,
): Promise<boolean> {
  if (bps === 0) return true;
  const rail = railOf(resolved);
  const deadline = (await DBOS.now()) + durationMs('timeout' in cfg ? cfg.timeout : '72h');
  let waiting = false;
  while (true) {
    const ok = await tx(`lock_${kind}`, (db) => lockFunds(db, deal, kind, bps));
    if (ok) return true;
    if (!waiting) {
      const reason = `waiting for ${kind === 'escrow' ? 'buyer funds' : 'seller margin'}`;
      await tx('awaiting_funding', (db) =>
        setStatus(
          db,
          deal.id,
          'awaiting_funding',
          { type: 'awaiting_funding', payload: { kind } },
          reason,
        ),
      );
      waiting = true;
    }
    if (rail.capabilities.pullToLock && (await pullShortfall(deal, rail, kind, bps))) continue;
    const now = await DBOS.now();
    if (now >= deadline) return false;
    await DBOS.recv(Topics.funds, { deadlineEpochMS: Math.min(deadline, now + 3_600_000) });
  }
}

/** Where the rail can debit the member, bring in what a lock is short of. True if money arrived. */
async function pullShortfall(
  deal: DealRow,
  rail: SettlementRail,
  kind: LockKind,
  bps: number,
): Promise<boolean> {
  const memberId = lockOwner(deal, kind);
  const currency = lockCurrency(deal, kind);
  const { member, shortfall } = await tx('lock_shortfall', async (db) => {
    const account = Accounts.memberAvailable(memberId, currency);
    const held = await deps().ledger.balance(db, deal.tenantId, account);
    return { member: await getMember(db, memberId), shortfall: lockAmount(deal, kind, bps) - held };
  });
  if (shortfall <= 0n) return false;
  let result: RailResult;
  try {
    const first = await networkStep('lock_pull', () =>
      rail.collect({
        idempotencyKey: shortKey(`lock:${deal.id}:${kind}:${shortfall}`),
        member: { id: member.id, railRefs: member.railRefs },
        currency,
        amount: shortfall,
        reference: `novate deal ${deal.id.slice(0, 8)}`,
      }),
    );
    result = await pollWhileSubmitted('lock_pull_status', first, 20, (ref) =>
      rail.status(ref, 'collect'),
    );
  } catch (err) {
    // The same idempotency key goes out next time round, so an unanswered pull cannot double up.
    if (isWorkflowControl(err)) throw err;
    console.warn(`Pull for deal ${deal.id} got no answer:`, (err as Error).message);
    return false;
  }
  if (result.status !== 'confirmed') return false;
  await deposit(deal.tenantId, {
    memberId,
    currency,
    amount: shortfall,
    rail: rail.name,
    externalRef: result.externalRef,
  });
  return true;
}

async function lockFunds(db: Tx, deal: DealRow, kind: LockKind, bps: number): Promise<boolean> {
  const amount = lockAmount(deal, kind, bps);
  if (amount === 0n) return true;
  const currency = lockCurrency(deal, kind);
  const posted = await tryPost(db, deal.tenantId, [
    {
      key: `deal:${deal.id}:${kind}:lock`,
      debit: Accounts.memberAvailable(lockOwner(deal, kind), currency),
      credit: lockAccount(deal, kind),
      amount,
      kind: `${kind}_lock`,
      ref: deal.id,
    },
  ]);
  if (!posted) return false;
  await record(db, deal.id, `${kind}_locked`, {
    amount,
    currency,
    bps,
    ...lockFx(deal, kind, bps),
  });
  return true;
}

// ── Release conditions ─────────────────────────────────────────────────────

type ReleaseOutcome = { outcome: 'release'; forcedBps?: number } | { outcome: Terminal };

async function awaitRelease(
  deal: DealRow,
  resolved: ResolvedPolicy,
  start: number,
): Promise<ReleaseOutcome> {
  const { release, decisions } = resolved.policy;
  await tx('awaiting', (db) =>
    setStatus(db, deal.id, 'awaiting_conditions', { type: 'awaiting_conditions' }, null),
  );
  const deadline = start + durationMs(release.timeout);
  let lastEscalated = '';
  while (true) {
    const now = await DBOS.now();
    const { result, factCount } = await tx('evaluate', (db) => evaluateDeal(db, deal, now));
    if (result.state === 'satisfied') return { outcome: 'release' };
    const expired = now >= deadline;

    if (expired && release.onTimeout === 'release')
      return { outcome: 'release', forcedBps: 10_000 };
    if (expired && release.onTimeout === 'refund') {
      const reason = 'release conditions not met in time';
      await tx('unwind', (db) => unwind(db, deal, 'refunded', reason, true));
      return { outcome: 'refunded' };
    }

    // Only ask again when the evidence or the findings have changed.
    // Past the deadline it comes up again each day, so a deal holding funds cannot go quiet.
    const overdueDay = expired ? Math.floor(now / 86_400_000) : 'open';
    const fingerprint = `${factCount}:${result.findings.map((f) => f.code).join(',')}:${overdueDay}`;
    const escalate =
      (result.state === 'blocked' && release.onBlocked === 'escalate') ||
      (expired && release.onTimeout === 'escalate');

    if (escalate && fingerprint !== lastEscalated) {
      lastEscalated = fingerprint;
      const held = await reviewHeldDeal(deal, decisions, result, expired);
      if (held.next === 'recheck') {
        if (held.staleCase) lastEscalated = '';
        continue;
      }
      if (held.next === 'finish') return held.outcome;
    }

    const wake = await DBOS.now();
    await DBOS.recv(Topics.fact, {
      deadlineEpochMS: Math.max(
        wake + 1_000,
        Math.min(
          expired ? Number.MAX_SAFE_INTEGER : deadline,
          wake + durationMs(release.recheckEvery),
        ),
      ),
    });
  }
}

type HeldReview =
  | { next: 'finish'; outcome: ReleaseOutcome }
  | { next: 'recheck'; staleCase: boolean }
  | { next: 'wait' };

/** Evidence does not match the deal, or time ran out. A decider says what happens next. */
async function reviewHeldDeal(
  deal: DealRow,
  decisions: CaseSpec['decisions'],
  result: ConditionResult,
  expired: boolean,
): Promise<HeldReview> {
  const reason = expired ? 'Release conditions timed out' : findingsReason(result.findings);
  const marginPosted = await tx('held', async (db) => {
    await setStatus(
      db,
      deal.id,
      'held',
      {
        type: 'held',
        payload: {
          reason,
          findings: result.findings.map(({ code, message, factId }) => ({ code, message, factId })),
        },
      },
      reason,
    );
    return deal.marginCurrency
      ? deps().ledger.balance(db, deal.tenantId, lockAccount(deal, 'margin'))
      : 0n;
  });
  await notifySeller(deal, 0n, 'held', reason);
  const res = await resolveCase(
    dealCase(
      deal,
      decisions,
      'held',
      reason,
      { findings: result.findings, trace: result.trace, expired },
      {
        findings: result.findings.map((f) => ({ code: f.code, waivable: f.waivable })),
        marginPosted,
      },
    ),
  );
  if (res.outcome === 'stale') return { next: 'recheck', staleCase: true };

  const action = res.outcome === 'decided' ? res.action : undefined;
  switch (action?.type) {
    case 'refund': {
      const why = `refunded by ${res.outcome === 'decided' ? res.decider.type : 'review'}`;
      await tx('unwind', (db) => unwind(db, deal, 'refunded', why, true));
      return { next: 'finish', outcome: { outcome: 'refunded' } };
    }
    case 'release_full':
      return { next: 'finish', outcome: { outcome: 'release', forcedBps: 10_000 } };
    case 'release_partial':
      return { next: 'finish', outcome: { outcome: 'release', forcedBps: action.bps } };
    case 'waive': {
      const codes = action.codes ?? result.findings.filter((f) => f.waivable).map((f) => f.code);
      const waivers = result.findings.filter((f) => codes.includes(f.code));
      await tx('waive', (db) => waive(db, deal, waivers));
      return { next: 'recheck', staleCase: false };
    }
    case 'draw_margin':
      await tx('draw', (db) =>
        drawMargin(
          db,
          deal,
          res.outcome === 'decided' ? res.caseId : 'review',
          BigInt(action.amount),
          action.reason,
        ),
      );
      break;
  }
  await tx('awaiting', (db) =>
    setStatus(db, deal.id, 'awaiting_conditions', { type: 'held_for_evidence' }, reason),
  );
  return { next: 'wait' };
}

async function conditionContext(db: Tx, deal: DealRow, now: number): Promise<ConditionContext> {
  const terms = DealTerms.parse(deal.terms);
  const snap = snapshotOf(deal);
  return {
    deal: {
      amount: deal.amount,
      currency: deal.currency,
      quantity: deal.quantity,
      shipmentDate: terms.shipmentDate,
      description: terms.lines.map((l) => l.description).join('; '),
      authorisedAt: snap.authorisedAt,
    },
    facts: await listFacts(db, deal.id),
    now: new Date(now),
    extra: { signals: signalValues(snap.signals), attributes: terms.attributes },
  };
}

async function evaluateDeal(
  db: Tx,
  deal: DealRow,
  now: number,
): Promise<{ result: ConditionResult; factCount: number }> {
  const ctx = await conditionContext(db, deal, now);
  const result = evaluateCondition(snapshotOf(deal).resolved.policy.release.condition, ctx);
  await recordEvaluationIfChanged(db, deal, result);
  return { result, factCount: ctx.facts.length };
}

/** Conditions are rechecked for weeks. Only a change belongs in the audit trail. */
async function recordEvaluationIfChanged(db: Tx, deal: DealRow, result: ConditionResult) {
  const [last] = await db
    .select({ payload: dealEvents.payload })
    .from(dealEvents)
    .where(and(eq(dealEvents.dealId, deal.id), eq(dealEvents.type, 'conditions_evaluated')))
    .orderBy(desc(dealEvents.createdAt))
    .limit(1);
  const payload = { state: result.state, trace: result.trace };
  if (last && JSON.stringify(last.payload) === JSON.stringify(payload)) return;
  await record(db, deal.id, 'conditions_evaluated', payload);
}

async function waive(db: Tx, deal: DealRow, findings: Finding[]) {
  if (findings.length) {
    await db.insert(dealFacts).values(
      findings.map((f) => ({
        dealId: deal.id,
        kind: 'waiver',
        type: 'decision',
        source: 'gateway',
        data: { code: f.code, factId: f.factId },
      })),
    );
  }
  const codes = findings.map((f) => f.code);
  await setStatus(db, deal.id, 'awaiting_conditions', { type: 'waived', payload: { codes } }, null);
}

/**
 * Pay the buyer out of the seller's margin. The key is per `occasion`, so a replay posts once and a
 * later draw still posts, even when the balance has returned to the same figure after a top-up.
 */
async function drawMargin(db: Tx, deal: DealRow, occasion: string, amount: bigint, reason: string) {
  if (!deal.marginCurrency || amount === 0n) return;
  const { ledger } = deps();
  const account = lockAccount(deal, 'margin');
  const posted = await ledger.balance(db, deal.tenantId, account);
  const take = minBig(amount, posted);
  if (take === 0n) return;
  await ledger.post(db, deal.tenantId, [
    {
      key: `deal:${deal.id}:margin:draw:${occasion}`,
      debit: account,
      credit: Accounts.memberAvailable(deal.buyerMemberId, deal.marginCurrency),
      amount: take,
      kind: 'margin_draw',
      ref: deal.id,
    },
  ]);
  await record(db, deal.id, 'margin_drawn', {
    amount: take,
    currency: deal.marginCurrency,
    reason,
  });
}

// ── Release and close ──────────────────────────────────────────────────────

/** The seller is the one waiting on this money, so it hears when it gets less, or not yet. */
const notifySeller = (deal: DealRow, amount: bigint, status: 'reduced' | 'held', reason: string) =>
  notify({
    type: 'payment_reduced',
    tenantId: deal.tenantId,
    memberId: deal.sellerMemberId,
    dealId: deal.id,
    currency: deal.currency,
    expected: deal.amount.toString(),
    amount: amount.toString(),
    status,
    reason,
  });

async function releaseFunds(
  db: Tx,
  deal: DealRow,
  now: number,
  forcedBps: number | undefined,
): Promise<bigint> {
  const { ledger } = deps();
  const { policy } = snapshotOf(deal).resolved;
  const ctx = await conditionContext(db, deal, now);
  const amount =
    forcedBps === undefined
      ? releaseAmount(policy.release.amount, ctx)
      : applyBps(deal.amount, forcedBps);

  const currency = lockCurrency(deal, 'escrow');
  const escrow = lockAccount(deal, 'escrow');
  const held = await ledger.balance(db, deal.tenantId, escrow);
  // In the deal's currency, keep exactly the amount. In another, keep the same share, buffer included.
  const keep =
    currency === deal.currency
      ? minBig(held, amount)
      : amount === deal.amount
        ? held
        : mulDivUp(held, amount, deal.amount);
  if (held > keep) {
    await ledger.post(db, deal.tenantId, [
      {
        key: `deal:${deal.id}:escrow:excess`,
        debit: escrow,
        credit: Accounts.memberAvailable(deal.buyerMemberId, currency),
        amount: held - keep,
        kind: 'escrow_refund',
        ref: deal.id,
      },
    ]);
  }

  const shortfall = deal.amount - amount;
  const drawBps = policy.marginUse.shortfallDrawBps;
  if (shortfall > 0n && drawBps > 0 && deal.marginCurrency) {
    const draw = inLockCurrency(deal, applyBps(shortfall, drawBps), deal.marginCurrency);
    await drawMargin(db, deal, 'shortfall', draw, 'pro-rata shortfall');
  }

  await db
    .update(obligations)
    .set(amount > 0n ? { amount, status: 'eligible' } : { status: 'cancelled' })
    .where(eq(obligations.dealId, deal.id));

  const terms = DealTerms.parse(deal.terms);
  // A leg can round to nothing on a small deal, and netting refuses a zero obligation.
  const legs = terms.legs
    .map((leg) => ({ leg, legAmount: applyBps(amount, leg.bps) }))
    .filter(({ legAmount }) => legAmount > 0n);
  if (legs.length) {
    await db
      .insert(obligations)
      .values(
        legs.map(({ leg, legAmount }) => ({
          tenantId: deal.tenantId,
          dealId: deal.id,
          leg: leg.id,
          payerMemberId: leg.payer === 'buyer' ? deal.buyerMemberId : deal.sellerMemberId,
          payeeMemberId: leg.payeeMemberId,
          currency: deal.currency,
          amount: legAmount,
          settlementGroup: settlementGroup(deal, policy.settlement),
          status: 'eligible' as const,
        })),
      )
      .onConflictDoNothing();
  }

  await db.update(deals).set({ releaseAmount: amount }).where(eq(deals.id, deal.id));
  const late = shippedLate(ctx, terms);
  await setStatus(
    db,
    deal.id,
    'eligible',
    {
      type: 'released',
      payload: {
        amount,
        currency: deal.currency,
        of: deal.amount,
        forced: forcedBps !== undefined,
        late,
      },
    },
    null,
  );
  return amount;
}

function shippedLate(ctx: ConditionContext, terms: DealTerms): boolean {
  const agreed = terms.shipmentDate;
  if (!agreed) return false;
  return ctx.facts.some((f) => {
    const shipped = (f.data.fields as { shipmentDate?: unknown } | undefined)?.shipmentDate;
    return f.kind === 'document' && typeof shipped === 'string' && shipped > agreed;
  });
}

/** Return what is held for a deal and close it. `sellerAtFault` applies the program's forfeit rule. */
async function unwind(
  db: Tx,
  deal: DealRow,
  status: 'cancelled' | 'refunded',
  reason: string,
  sellerAtFault: boolean,
) {
  const { ledger } = deps();
  const transfers: TransferInput[] = [];
  const held = await ledger.balance(db, deal.tenantId, lockAccount(deal, 'escrow'));
  const posted = await ledger.balance(db, deal.tenantId, lockAccount(deal, 'margin'));
  const forfeit =
    sellerAtFault &&
    Boolean(deal.policySnapshot) &&
    snapshotOf(deal).resolved.policy.marginUse.onNonPerformance === 'forfeit';
  if (held > 0n) {
    transfers.push({
      key: `deal:${deal.id}:escrow:unwind`,
      debit: lockAccount(deal, 'escrow'),
      credit: Accounts.memberAvailable(deal.buyerMemberId, lockCurrency(deal, 'escrow')),
      amount: held,
      kind: 'escrow_refund',
      ref: deal.id,
    });
  }
  if (posted > 0n) {
    transfers.push({
      key: `deal:${deal.id}:margin:unwind`,
      debit: lockAccount(deal, 'margin'),
      credit: Accounts.memberAvailable(
        forfeit ? deal.buyerMemberId : deal.sellerMemberId,
        lockCurrency(deal, 'margin'),
      ),
      amount: posted,
      kind: forfeit ? 'margin_forfeit' : 'margin_release',
      ref: deal.id,
    });
  }
  await ledger.post(db, deal.tenantId, transfers);
  await db.update(obligations).set({ status: 'cancelled' }).where(eq(obligations.dealId, deal.id));
  const marginReturned = forfeit ? 0n : posted;
  await setStatus(
    db,
    deal.id,
    status,
    {
      type: status,
      payload: {
        reason,
        escrowReturned: held,
        currency: lockCurrency(deal, 'escrow'),
        marginReturned,
        marginCurrency: lockCurrency(deal, 'margin'),
        forfeited: forfeit,
      },
    },
    reason,
  );
}

/** A suspended member never came good. Skipped if a cycle has since picked the deal up. */
async function refundUncured(db: Tx, deal: DealRow, sellerAtFault: boolean): Promise<boolean> {
  const [current] = await db.select().from(deals).where(eq(deals.id, deal.id)).for('update');
  if (current?.status !== 'eligible') return false;
  await unwind(db, deal, 'refunded', 'a suspended member did not cure in time', sellerAtFault);
  return true;
}

async function completeDeal(db: Tx, deal: DealRow, cycleId: string, paid: bigint) {
  const { ledger } = deps();
  const margin = lockAccount(deal, 'margin');
  const posted = await ledger.balance(db, deal.tenantId, margin);
  if (posted > 0n) {
    await ledger.post(db, deal.tenantId, [
      {
        key: `deal:${deal.id}:margin:release`,
        debit: margin,
        credit: Accounts.memberAvailable(deal.sellerMemberId, lockCurrency(deal, 'margin')),
        amount: posted,
        kind: 'margin_release',
        ref: deal.id,
      },
    ]);
  }
  await setStatus(
    db,
    deal.id,
    'settled',
    {
      type: 'settled',
      payload: {
        cycleId,
        amount: paid,
        currency: deal.currency,
        marginReturned: posted,
        marginCurrency: lockCurrency(deal, 'margin'),
      },
    },
    null,
  );
}
