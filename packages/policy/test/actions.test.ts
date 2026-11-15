import { describe, expect, it } from 'vitest';
import {
  type Action,
  type ActionCheck,
  type ActionContext,
  checkAction,
  DecisionLimits,
  describeCheck,
  ProgramSpec,
  presets,
  releaseAmount,
  validateAction,
  validateFactData,
} from '../src/index.ts';

const ctx = (over: Partial<ActionContext> = {}): ActionContext => ({
  kind: 'held',
  decider: 'model',
  amount: 100_000n,
  currency: 'EUR',
  ceiling: { EUR: 1_000_000 },
  limits: DecisionLimits.parse({}),
  findings: [
    { code: 'bl.shipment_late', waivable: true },
    { code: 'inv.currency_mismatch', waivable: false },
  ],
  marginPosted: 5_000n,
  ...over,
});
const check = (a: Action, c: Partial<ActionContext> = {}) => validateAction(ctx(c), a);

describe('a difference in client money', () => {
  const ack: Action = { type: 'acknowledge', note: 'timing' };
  const recon = { kind: 'recon_break' as const };

  it('can only be acknowledged by a person, while agents may still stop settlement', () => {
    expect(check(ack, { ...recon, decider: 'model' })).toEqual([
      'acknowledging a reconciliation difference is reserved for a person',
    ]);
    expect(check(ack, { ...recon, decider: 'rule' })).toHaveLength(1);
    expect(check(ack, { ...recon, decider: 'person' })).toEqual([]);
    expect(check({ type: 'halt_settlement' }, { ...recon, decider: 'model' })).toEqual([]);
  });
});

describe('checkAction', () => {
  it('names each check with a stable code', () => {
    const waive = checkAction(ctx(), { type: 'waive', codes: ['bl.shipment_late'] });
    expect(waive.map((c) => [c.code, c.params])).toEqual([
      ['allowed_action', { action: 'waive', kind: 'held' }],
      ['ceiling', undefined],
      ['waivable', undefined],
      ['open_finding', { finding: 'bl.shipment_late' }],
      ['waivable', { finding: 'bl.shipment_late' }],
      ['program_allows_waive', { finding: 'bl.shipment_late' }],
    ]);
    const draw = checkAction(ctx(), { type: 'draw_margin', amount: '9000', reason: 'short' });
    expect(draw.filter((c) => !c.passed).map((c) => c.code)).toEqual([
      'draw_within_posted',
      'draw_share',
    ]);
    expect(checkAction(ctx(), { type: 'confirm' })).toEqual([
      { code: 'allowed_action', params: { action: 'confirm', kind: 'held' }, passed: false },
    ]);
  });

  it('words each check from its code and numbers', () => {
    const [allowed] = checkAction(ctx(), { type: 'confirm' });
    expect(describeCheck(allowed as ActionCheck)).toBe('confirm is not allowed on a held case');
    expect(describeCheck({ ...(allowed as ActionCheck), passed: true })).toBe(
      'confirm is one of the actions allowed on a held case',
    );
    const reprice = checkAction(ctx({ kind: 'frozen', newAmount: 1n }), {
      type: 'reprice',
      lines: [] as never,
    }).find((c) => c.code === 'reprice_floor') as ActionCheck;
    expect(reprice.params).toMatchObject({ amount: '1', currency: 'EUR' });
    expect(describeCheck(reprice)).toMatch(
      /^reprice to 0\.01 EUR is below the allowed \d+\.\d{2} EUR$/,
    );
  });
});

describe('validateAction', () => {
  it('never lets an agent take a reserve below what the review supports', () => {
    const review = { kind: 'margin_review', marginFloorBps: 500 } as const;
    expect(check({ type: 'resize_margin', bps: 0 }, review)[0]).toMatch(/below/);
    expect(check({ type: 'resize_margin', bps: 800 }, review)).toEqual([]);
    expect(check({ type: 'resize_margin', bps: 0 }, { ...review, decider: 'person' })).toEqual([]);
  });
  it('refuses a retry or an extension once no attempts are left', () => {
    const settlement = { kind: 'settlement_exception', attemptsLeft: 0 } as const;
    expect(check({ type: 'retry_settlement' }, settlement)[0]).toMatch(/no attempts/);
    expect(check({ type: 'retry_settlement' }, { ...settlement, attemptsLeft: 1 })).toEqual([]);
    const breach = { kind: 'margin_breach', attemptsLeft: 0 } as const;
    expect(check({ type: 'extend_call' }, breach)[0]).toMatch(/no attempts/);
    expect(check({ type: 'declare_default' }, breach)).toEqual([]);
  });
  it('refuses an action of the wrong kind for the case', () => {
    expect(check({ type: 'confirm' })[0]).toMatch(/not allowed/);
  });
  it('refuses automated decisions above the ceiling but allows people', () => {
    expect(check({ type: 'waive' }, { amount: 2_000_000n })[0]).toMatch(/ceiling/);
    expect(check({ type: 'refund' }, { amount: 2_000_000n, decider: 'person' })).toEqual([]);
  });
  it('refuses a currency with no ceiling set', () => {
    expect(check({ type: 'waive' }, { currency: 'USD' })[0]).toMatch(/ceiling/);
  });
  it('never waives a non-waivable finding, even for a person', () => {
    expect(
      check({ type: 'waive', codes: ['inv.currency_mismatch'] }, { decider: 'person' })[0],
    ).toMatch(/cannot be waived/);
  });
  it('honours the tenant’s list of codes agents may waive', () => {
    const limits = DecisionLimits.parse({ waivableCodes: ['*.quantity_mismatch'] });
    expect(check({ type: 'waive', codes: ['bl.shipment_late'] }, { limits })[0]).toMatch(/outside/);
  });
  it('reserves force release for people by default', () => {
    expect(check({ type: 'release_full' })[0]).toMatch(/reserved/);
    expect(check({ type: 'release_full' }, { decider: 'person' })).toEqual([]);
  });
  it('caps margin draws at what is posted', () => {
    expect(check({ type: 'draw_margin', amount: '6000', reason: 'x' })[0]).toMatch(
      /exceeds posted/,
    );
  });
  it('refuses refunds and margin draws by agents unless a tenant opts in', () => {
    expect(check({ type: 'refund' })[0]).toMatch(/reserved/);
    expect(check({ type: 'draw_margin', amount: '1', reason: 'x' })[0]).toMatch(/share of margin/);
  });
  it('sets a floor on an agent repricing a deal down', () => {
    expect(
      check({ type: 'reprice', lines: [] as never }, { kind: 'frozen', newAmount: 1n })[0],
    ).toMatch(/below/);
  });
  it('limits how far an agent can raise a reprice', () => {
    expect(
      check({ type: 'reprice', lines: [] as never }, { kind: 'frozen', newAmount: 100_001n })[0],
    ).toMatch(/exceeds/);
  });
  it('only accepts a settlement plan code generated', () => {
    expect(
      check(
        { type: 'choose_plan', planId: 'mine' },
        { kind: 'settlement_exception', planIds: ['net'] },
      )[0],
    ).toMatch(/generated/);
  });
  it('lets a model escalate even above the ceiling', () => {
    expect(check({ type: 'escalate', note: 'n' }, { amount: 9_000_000n })).toEqual([]);
  });
});

describe('evidence rules', () => {
  const base = { amount: 1000n, currency: 'EUR', quantity: 1, authorisedAt: '' };
  const fact = (data: Record<string, unknown>) => ({
    id: '1',
    kind: 'inspection',
    type: 't',
    source: 's',
    data,
    createdAt: '',
  });
  it('clamps a pass rate that somehow got through', () => {
    const c = { deal: base, facts: [fact({ passRate: 2 })], now: new Date() };
    expect(releaseAmount({ type: 'pro_rata_inspection' }, c)).toBe(1000n);
  });
  it('rejects bad evidence at the door', () => {
    expect(validateFactData('inspection', { passRate: 2 })).toBeTruthy();
    expect(validateFactData('inspection', {})).toBeTruthy();
    expect(validateFactData('inspection', { inspected: 10, passed: 9 })).toBeNull();
    expect(validateFactData('document', { fields: { amount: 1.5 } })).toBeTruthy();
  });
});

describe('rule expressions', () => {
  const withCheck = (when: string) =>
    ProgramSpec.safeParse({
      ...presets.netSettlement,
      checks: [{ id: 'c', when, action: 'flag', reason: 'r' }],
    }).success;
  it('refuses nested comprehensions that could hang the server', () => {
    const nested = '[1].map(a, [1].map(b, [1].map(c, [1].map(d, 1))))';
    expect(withCheck(`size(${nested}) > 0`)).toBe(false);
  });
  it('still allows a simple comprehension', () => {
    expect(withCheck('[1, 2].all(a, a > 0)')).toBe(true);
  });
});

describe('program validation', () => {
  const withCondition = (condition: unknown) =>
    ProgramSpec.safeParse({ ...presets.netSettlement, release: { condition } }).success;
  it('rejects typos and malformed built-in conditions at publish', () => {
    expect(withCondition({ type: 'documnets', require: ['x'] })).toBe(false);
    expect(withCondition({ type: 'documents' })).toBe(false);
    expect(withCondition({ type: 'inspection', minPassRate: 5 })).toBe(false);
  });
  it('still accepts valid conditions', () => {
    expect(withCondition({ type: 'acceptance' })).toBe(true);
  });
});

describe('a claim after settlement', () => {
  const claim = (claimant: 'buyer' | 'seller', limits: Partial<DecisionLimits>) =>
    ({ kind: 'exception', claimant, limits: DecisionLimits.parse(limits) }) as const;

  it("grants a seller's claim under the refund limit, not the force release limit", () => {
    const pay: Action = { type: 'release_full' };
    expect(check(pay, claim('seller', { allowForceRelease: true }))).toEqual([
      "paying a seller's claim is reserved for people on this program",
    ]);
    expect(check(pay, claim('seller', { allowRefund: true }))).toEqual([]);
    expect(check(pay, { ...claim('seller', {}), decider: 'person' })).toEqual([]);
    expect(check(pay, claim('buyer', { allowRefund: true, allowForceRelease: true }))).toHaveLength(
      1,
    );
  });

  it("grants a buyer's claim under the refund limit only", () => {
    const refund: Action = { type: 'refund' };
    expect(check(refund, claim('buyer', { allowForceRelease: true }))).toEqual([
      'refunds are reserved for people on this program',
    ]);
    expect(check(refund, claim('buyer', { allowRefund: true }))).toEqual([]);
    expect(check(refund, claim('seller', { allowRefund: true }))).toHaveLength(1);
  });
});
