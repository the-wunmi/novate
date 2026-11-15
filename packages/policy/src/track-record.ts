import { z } from 'zod';
import { type ActionType, Bps, type CaseKind } from './actions.ts';

export type Verdict = 'good' | 'bad' | 'neutral';

/** What actually happened after a decision. Built by the engine; judged here. */
export type OutcomeSignals =
  | {
      subject: 'deal';
      status: 'open' | 'settled' | 'refunded' | 'cancelled';
      disputed: boolean;
      /** The same trade was submitted again and went through, so stopping it was a mistake. */
      resubmittedAndSettled: boolean;
      /** Long enough has passed that a resubmission would have happened by now. */
      resubmitWindowOver: boolean;
      /** The decision put more of the seller's money at risk of being held. */
      raisedReserve: boolean;
    }
  | { subject: 'call'; status: 'open' | 'met' | 'defaulted' }
  | { subject: 'cycle'; status: 'open' | 'settled' | 'failed'; anyoneFailed: boolean }
  | { subject: 'recon'; next: 'pending' | 'clean' | 'breaks' }
  | { subject: 'agent'; matured: boolean; suspendedAgain: boolean };

const judgeDeal = (
  kind: CaseKind,
  action: ActionType,
  s: Extract<OutcomeSignals, { subject: 'deal' }>,
): Verdict | null => {
  if (kind === 'frozen' && action === 'cancel') {
    if (s.resubmittedAndSettled) return 'bad';
    return s.resubmitWindowOver ? 'neutral' : null;
  }
  if (s.status === 'open') return null;
  const clean = s.status === 'settled' && !s.disputed;
  const wentWrong = s.disputed || s.status === 'refunded';
  const byResult = clean ? 'good' : wentWrong ? 'bad' : 'neutral';
  switch (kind) {
    case 'frozen':
      return action === 'confirm' || action === 'reprice' ? byResult : 'neutral';
    case 'held':
      if (action === 'waive' || action === 'release_full' || action === 'release_partial') {
        return byResult;
      }
      return action === 'request_evidence' && clean ? 'good' : 'neutral';
    case 'margin_review':
      // A bigger reserve on a deal that went wrong was the right call.
      if (s.raisedReserve) return wentWrong ? 'good' : 'neutral';
      return byResult;
    default:
      return 'neutral';
  }
};

/**
 * Whether a decision turned out well. Null means it is too early to say. Choices whose results
 * cannot be observed, such as cancelling a deal nobody retried, are neutral and do not count.
 */
export function judgeDecision(
  kind: CaseKind,
  action: ActionType,
  s: OutcomeSignals,
): Verdict | null {
  switch (s.subject) {
    case 'deal':
      return judgeDeal(kind, action, s);
    case 'call':
      if (s.status === 'open') return null;
      if (action !== 'extend_call') return 'neutral';
      return s.status === 'met' ? 'good' : 'bad';
    case 'cycle': {
      if (s.status === 'open') return null;
      const judged = action === 'retry_settlement' || kind === 'treasury_review';
      if (!judged) return 'neutral';
      return s.status === 'settled' && !s.anyoneFailed ? 'good' : 'bad';
    }
    case 'recon':
      if (s.next === 'pending') return null;
      if (action !== 'acknowledge') return 'neutral';
      return s.next === 'clean' ? 'good' : 'bad';
    case 'agent':
      if (!s.matured) return null;
      if (action !== 'no_action' && action !== 'reinstate_agent') return 'neutral';
      return s.suspendedAgain ? 'bad' : 'good';
  }
}

/** How far agents may decide on their own. The tenant's ceiling is always the upper limit. */
export const Autonomy = z.discriminatedUnion('mode', [
  /** Agents may decide up to the whole ceiling from the first day. */
  z.object({ mode: z.literal('fixed') }),
  z.object({
    mode: z.literal('earned'),
    /** The share of the ceiling agents start with. */
    startBps: Bps.default(2_500),
    /** Below this many judged decisions, there is nothing to go on yet. */
    minJudged: z.int().min(1).default(30),
    /** At or below this confidence agents get only `startBps`; at `targetScoreBps` the ceiling. */
    floorScoreBps: Bps.default(8_000),
    targetScoreBps: Bps.default(9_500),
    /** A success smaller than this share of the ceiling proves nothing about larger decisions. */
    minDecisionBps: Bps.default(100),
    /** How many successes between the same two members can count, so a pair cannot farm a record. */
    maxGoodPerPair: z.int().min(1).default(3),
  }),
]);
export type Autonomy = z.infer<typeof Autonomy>;

export interface TrackRecord {
  good: number;
  bad: number;
  neutral: number;
}

export interface JudgedDecision {
  verdict: Verdict;
  amount: bigint;
  currency: string;
  /** The two members involved, if the decision was about a deal between them. */
  pair: string | null;
}

/**
 * Add up a record. Only successes are filtered, because they are what can be farmed with small
 * deals between friendly members. A failure always counts, whatever its size.
 */
export function tallyRecord(
  judged: JudgedDecision[],
  autonomy: Autonomy,
  ceiling: Record<string, number>,
): TrackRecord {
  const seen = new Map<string, number>();
  const counts = (d: JudgedDecision) => {
    if (autonomy.mode === 'fixed') return true;
    const least = (BigInt(ceiling[d.currency] ?? 0) * BigInt(autonomy.minDecisionBps)) / 10_000n;
    if (d.amount < least) return false;
    if (!d.pair) return true;
    const n = (seen.get(d.pair) ?? 0) + 1;
    seen.set(d.pair, n);
    return n <= autonomy.maxGoodPerPair;
  };
  return {
    good: judged.filter((d) => d.verdict === 'good' && counts(d)).length,
    bad: judged.filter((d) => d.verdict === 'bad').length,
    neutral: judged.filter((d) => d.verdict === 'neutral').length,
  };
}

const Z_95 = 1.96;

/** The accuracy we can be 95% sure of. Three out of three proves far less than 300 out of 300. */
export function confidentScore({ good, bad }: TrackRecord): number {
  const n = good + bad;
  if (n === 0) return 0;
  const p = good / n;
  const z2 = Z_95 * Z_95;
  const centre = p + z2 / (2 * n);
  const margin = Z_95 * Math.sqrt((p * (1 - p) + z2 / (4 * n)) / n);
  return (centre - margin) / (1 + z2 / n);
}

/** The share of the ceiling agents have earned, in basis points. Falls as well as rises. */
export function earnedShareBps(record: TrackRecord, autonomy: Autonomy): number {
  if (autonomy.mode === 'fixed') return 10_000;
  const { startBps, minJudged, floorScoreBps, targetScoreBps } = autonomy;
  if (record.good + record.bad < minJudged) return startBps;
  const score = confidentScore(record) * 10_000;
  const progress = (score - floorScoreBps) / Math.max(1, targetScoreBps - floorScoreBps);
  return Math.floor(startBps + (10_000 - startBps) * Math.min(1, Math.max(0, progress)));
}

export const earnedCeiling = (
  ceiling: Record<string, number>,
  shareBps: number,
): Record<string, number> =>
  Object.fromEntries(
    Object.entries(ceiling).map(([currency, limit]) => [
      currency,
      Math.floor((limit * shareBps) / 10_000),
    ]),
  );
