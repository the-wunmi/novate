import { describe, expect, it } from 'vitest';
import {
  Autonomy,
  confidentScore,
  earnedCeiling,
  earnedShareBps,
  firstAccepted,
  judgeDecision,
  type OutcomeSignals,
  type Proposal,
  tallyRecord,
} from '../src/index.ts';

const deal = (over: Partial<Extract<OutcomeSignals, { subject: 'deal' }>>): OutcomeSignals => ({
  subject: 'deal',
  status: 'settled',
  disputed: false,
  resubmittedAndSettled: false,
  resubmitWindowOver: true,
  raisedReserve: false,
  ...over,
});

describe('judging decisions', () => {
  it('waits for a deal to finish', () => {
    expect(judgeDecision('held', 'waive', deal({ status: 'open' }))).toBeNull();
  });
  it('credits a waiver only if the deal finished without complaint', () => {
    expect(judgeDecision('held', 'waive', deal({}))).toBe('good');
    expect(judgeDecision('held', 'waive', deal({ disputed: true }))).toBe('bad');
    expect(judgeDecision('held', 'waive', deal({ status: 'refunded' }))).toBe('bad');
  });
  it('counts a cancel as wrong only when the same trade later went through', () => {
    const stopped = { status: 'cancelled' as const };
    expect(judgeDecision('frozen', 'cancel', deal(stopped))).toBe('neutral');
    expect(
      judgeDecision('frozen', 'cancel', deal({ ...stopped, resubmittedAndSettled: true })),
    ).toBe('bad');
  });
  it('waits for the chance of a resubmission before judging a cancel', () => {
    const early = { status: 'cancelled' as const, resubmitWindowOver: false };
    expect(judgeDecision('frozen', 'cancel', deal(early))).toBeNull();
  });
  it('treats a raised reserve on a deal that went wrong as the right call', () => {
    const raised = { raisedReserve: true, status: 'refunded' as const };
    expect(judgeDecision('margin_review', 'resize_margin', deal(raised))).toBe('good');
    expect(judgeDecision('margin_review', 'resize_margin', deal({ status: 'refunded' }))).toBe(
      'bad',
    );
  });
  it('judges an extension by whether the call was met', () => {
    const call = (status: 'open' | 'met' | 'defaulted') => ({ subject: 'call', status }) as const;
    expect(judgeDecision('margin_breach', 'extend_call', call('open'))).toBeNull();
    expect(judgeDecision('margin_breach', 'extend_call', call('met'))).toBe('good');
    expect(judgeDecision('margin_breach', 'extend_call', call('defaulted'))).toBe('bad');
  });
  it('judges an acknowledged break by the next reconciliation', () => {
    expect(judgeDecision('recon_break', 'acknowledge', { subject: 'recon', next: 'breaks' })).toBe(
      'bad',
    );
  });
  it('judges a treasury choice by the cycle that followed', () => {
    const cycle = { subject: 'cycle', status: 'settled', anyoneFailed: true } as const;
    expect(judgeDecision('treasury_review', 'choose_plan', cycle)).toBe('bad');
  });
});

describe('earned limits', () => {
  const earned = Autonomy.parse({ mode: 'earned' });

  it('needs far more than a few successes to be confident', () => {
    expect(confidentScore({ good: 3, bad: 0, neutral: 0 })).toBeLessThan(0.5);
    expect(confidentScore({ good: 300, bad: 0, neutral: 0 })).toBeGreaterThan(0.98);
  });
  it('starts at the starting share until there is enough to judge', () => {
    expect(earnedShareBps({ good: 10, bad: 0, neutral: 50 }, earned)).toBe(2_500);
  });
  it('reaches the whole ceiling on a strong record', () => {
    expect(earnedShareBps({ good: 200, bad: 0, neutral: 0 }, earned)).toBe(10_000);
  });
  it('falls back when decisions start going wrong', () => {
    const before = earnedShareBps({ good: 190, bad: 2, neutral: 0 }, earned);
    const after = earnedShareBps({ good: 150, bad: 45, neutral: 0 }, earned);
    expect(after).toBeLessThan(before);
    expect(after).toBe(2_500);
  });
  it('never exceeds the tenant ceiling', () => {
    expect(earnedCeiling({ EUR: 1_000 }, 10_000)).toEqual({ EUR: 1_000 });
    expect(earnedCeiling({ EUR: 1_000 }, 2_500)).toEqual({ EUR: 250 });
  });
  it('leaves a fixed program alone', () => {
    expect(earnedShareBps({ good: 0, bad: 50, neutral: 0 }, { mode: 'fixed' })).toBe(10_000);
  });
});

describe('a record that cannot be farmed', () => {
  const earned = Autonomy.parse({ mode: 'earned' });
  const good = (amount: bigint, pair: string | null) => ({
    verdict: 'good' as const,
    amount,
    currency: 'EUR',
    pair,
  });
  const ceiling = { EUR: 100_000 };

  it('ignores successes too small to mean anything', () => {
    expect(tallyRecord([good(1n, 'a|b')], earned, ceiling).good).toBe(0);
    expect(tallyRecord([good(1_000n, 'a|b')], earned, ceiling).good).toBe(1);
  });
  it('caps how many successes one pair of members can contribute', () => {
    const farmed = Array.from({ length: 50 }, () => good(50_000n, 'a|b'));
    expect(tallyRecord(farmed, earned, ceiling).good).toBe(3);
  });
  it('always counts a failure, however small', () => {
    const failed = { ...good(1n, 'a|b'), verdict: 'bad' as const };
    expect(tallyRecord([failed], earned, ceiling).bad).toBe(1);
  });
});

describe('firstAccepted', () => {
  const answers = (...types: unknown[]) => {
    const seen: string[][] = [];
    let i = 0;
    return {
      seen,
      propose: async (prior: string[]) => {
        seen.push(prior);
        return { action: { type: types[i++] }, rationale: 'r' };
      },
    };
  };
  const refuseCancel = async (p: Proposal) =>
    p.action.type === 'cancel' ? ['no cancelling'] : p.action.type;

  it('feeds refusals back and returns the first accepted', async () => {
    const { seen, propose } = answers('cancel', 'confirm');
    expect(await firstAccepted(2, propose, refuseCancel)).toBe('confirm');
    expect(seen[1]).toEqual(['no cancelling']);
  });
  it('treats an invalid action as a refusal', async () => {
    const { seen, propose } = answers('nonsense', 'confirm');
    expect(await firstAccepted(2, propose, refuseCancel)).toBe('confirm');
    expect(seen[1]?.[0]).toContain('not a valid action');
  });
  it('gives up after the allowed attempts', async () => {
    expect(await firstAccepted(2, answers('cancel', 'cancel').propose, refuseCancel)).toBeNull();
  });
});
