import { DealShape } from '@novate/core';
import { z } from 'zod';
import { Bps, CASE_KINDS, DecisionLimits } from './actions.ts';
import { validateCel } from './cel.ts';
import { isCustomCondition } from './condition-registry.ts';
import { Duration } from './duration.ts';
import { Autonomy } from './track-record.ts';

const Cel = z.string().superRefine((expr, ctx) => {
  const err = validateCel(expr);
  if (err) ctx.addIssue({ code: 'custom', message: err });
});

// ── Conditions: when may held funds be released? ───────────────────────────

export const DocumentMatch = z.object({
  /** Accept a shipment this many days after the agreed date. */
  shipmentDateLateDays: z.int().min(0).default(0),
  quantityTolerancePct: z.number().min(0).default(0),
  amountTolerancePct: z.number().min(0).default(0),
  /** Fields each document type must carry. A document missing one is a finding, not a pass. */
  requireFields: z.record(z.string(), z.array(z.string()).min(1)).default({}),
});

export type ConditionNode =
  | { all: ConditionNode[] }
  | { any: ConditionNode[] }
  | { not: ConditionNode }
  | { type: 'documents'; require: string[]; match?: z.input<typeof DocumentMatch> }
  | { type: 'inspection'; minPassRate?: number }
  | { type: 'acceptance' }
  | { type: 'delivery' }
  | { type: 'no_dispute' }
  | { type: 'elapsed'; after: string }
  | { type: 'cel'; expr: string; description?: string }
  | { type: string; [param: string]: unknown };

export const ConditionNode: z.ZodType<ConditionNode> = z.lazy(() =>
  z.union([
    z.object({ all: z.array(ConditionNode).min(1) }),
    z.object({ any: z.array(ConditionNode).min(1) }),
    z.object({ not: ConditionNode }),
    z.object({
      type: z.literal('documents'),
      require: z.array(z.string()).min(1),
      match: DocumentMatch.optional(),
    }),
    z.object({ type: z.literal('inspection'), minPassRate: z.number().min(0).max(1).optional() }),
    z.object({ type: z.literal('elapsed'), after: Duration }),
    z.object({ type: z.literal('cel'), expr: Cel, description: z.string().optional() }),
    z.strictObject({ type: z.enum(['acceptance', 'delivery', 'no_dispute']) }),
    // Only condition types registered in code; a typo must fail at publish, not at runtime.
    z
      .looseObject({ type: z.string() })
      .refine((n) => isCustomCondition(n.type), { message: 'Unknown condition type' }),
  ]),
) as z.ZodType<ConditionNode>;

export const AmountRule = z.discriminatedUnion('type', [
  z.object({ type: z.literal('full') }),
  /** Pay only for the share that passed inspection. */
  z.object({ type: z.literal('pro_rata_inspection') }),
  z.object({ type: z.literal('cel'), expr: Cel }),
]);

// ── Program building blocks ────────────────────────────────────────────────

const LockCurrency = {
  /** `home` locks in the member's own currency, so only the net needs converting. */
  currency: z.enum(['deal', 'home']).default('deal'),
  /** Extra locked against the rate moving before settlement, when locking in another currency. */
  fxBufferBps: Bps.default(300),
};

export const Funding = z.discriminatedUnion('mode', [
  /** Buyer locks the full amount when the deal is accepted. */
  z.object({ mode: z.literal('prefunded'), timeout: Duration.default('72h'), ...LockCurrency }),
  /** Buyer locks a share up front; the rest is collected at settlement. */
  z.object({
    mode: z.literal('partial'),
    bps: Bps,
    timeout: Duration.default('72h'),
    ...LockCurrency,
  }),
  /** Nothing locked; the net position is collected when the cycle settles. */
  z.object({ mode: z.literal('net_then_fund') }),
]);

export const Margin = z.discriminatedUnion('mode', [
  z.object({ mode: z.literal('none') }),
  z.object({ mode: z.literal('fixed'), bps: Bps, timeout: Duration.default('72h') }),
  z.object({
    mode: z.literal('scored'),
    baseBps: Bps,
    adjustments: z.array(z.object({ when: Cel, addBps: z.int(), reason: z.string() })).default([]),
    minBps: Bps.default(0),
    maxBps: Bps.default(10_000),
    timeout: Duration.default('72h'),
  }),
]);

/** Collateral held per member across every open position, as a central counterparty does. */
export const PortfolioMargin = z.discriminatedUnion('mode', [
  z.object({ mode: z.literal('none') }),
  z.object({
    mode: z.literal('required'),
    /** Held against net payables whatever the market does. */
    baseBps: Bps,
    /** How many standard deviations of a currency move to hold against. */
    stressMultiple: z.number().positive().default(2.33),
    /** How long the house would take to close out a defaulter's positions. */
    horizonDays: z.number().positive().default(2),
    /** How much of a receivable in one currency offsets a payable in another. */
    crossOffsetBps: Bps.default(5_000),
    /** How long a member has to meet a margin call its wallet could not cover. */
    callWindow: Duration.default('4h'),
    maxExtensions: z.int().min(0).max(5).default(1),
  }),
]);
export type PortfolioMargin = z.infer<typeof PortfolioMargin>;

/** What seller margin is for. Without this it would only ever be returned. */
export const MarginUse = z.object({
  /** Share of a pro-rata shortfall paid to the buyer from margin. */
  shortfallDrawBps: Bps.default(0),
  /** Whether the buyer receives the margin when a seller never performs. */
  onNonPerformance: z.enum(['return', 'forfeit']).default('forfeit'),
});

export const Check = z.object({
  id: z.string(),
  when: Cel,
  action: z.enum(['freeze', 'reject', 'flag']),
  reason: z.string(),
});

export const Release = z.object({
  condition: ConditionNode,
  amount: AmountRule.default({ type: 'full' }),
  /** Re-evaluate at least this often (time-based conditions, polled signals). */
  recheckEvery: Duration.default('1h'),
  timeout: Duration.default('30d'),
  onTimeout: z.enum(['refund', 'escalate', 'release']).default('escalate'),
  /** When evidence contradicts the deal: ask a person, or wait for corrected evidence. */
  onBlocked: z.enum(['escalate', 'wait']).default('escalate'),
  /** How long after settlement a party may still file a claim against the deal. */
  claimWindow: Duration.default('7d'),
});

export const SettlementTiming = z.discriminatedUnion('mode', [
  /** Settle on a repeating schedule. */
  z.object({ mode: z.literal('cycle'), every: Duration }),
  /** Settle each deal alone as soon as it is released. */
  z.object({ mode: z.literal('immediate') }),
  /** Settle only when asked. */
  z.object({ mode: z.literal('manual') }),
]);

export const Settlement = z.object({
  /** `verify_only` checks the deal and its evidence but moves no money. */
  mode: z.enum(['clear', 'verify_only']).default('clear'),
  netting: z.enum(['multilateral', 'bilateral', 'gross']).default('multilateral'),
  rail: z.string().min(1),
  timing: SettlementTiming.default({ mode: 'manual' }),
  /** How long a net debtor has to fund before it is treated as a default. */
  fundingWindow: Duration.default('24h'),
  /** A payment still unconfirmed after this is flagged in doubt, but never assumed failed. */
  confirmWithin: Duration.default('5d'),
  /** How long a suspended member's deferred deals wait to be cured before they are refunded. */
  cureWindow: Duration.default('7d'),
});

/**
 * What the platform charges, as basis points of each settled deal. `platformShareBps` of each fee
 * is the platform's revenue and the rest is the house's.
 */
export const Fees = z.object({
  sellerBps: Bps.default(0),
  buyerBps: Bps.default(0),
  platformShareBps: Bps.default(10_000),
});
export type Fees = z.infer<typeof Fees>;

/** Who loses if a net debtor defaults. */
export const Risk = z.object({
  /**
   * `agent`: the house only passes money through, so a defaulter's obligations drop out and the
   * rest re-net. `principal`: the house pays creditors regardless and absorbs the loss.
   */
  bearer: z.enum(['agent', 'principal']).default('agent'),
  /** With a principal bearer, draw on members' mutual contributions before the house's own money. */
  defaultFund: z.boolean().default(false),
});

export const DealShapePolicy = z.object({
  allowed: z.array(DealShape).min(1).default(['goods', 'service', 'payment']),
  requireSku: z.boolean().default(false),
  /** Largest total of extra legs as a share of the deal. Off unless a tenant opts in. */
  maxLegsBps: Bps.default(0),
});

export const Authority = z.object({
  enforceMandate: z.boolean().default(true),
  /** Extra authority rules; each must be true for the deal to proceed. */
  rules: z.array(z.object({ when: Cel, reason: z.string() })).default([]),
});

export const DeciderKind = z.enum(['rules', 'model', 'person']);
export type DeciderKind = z.infer<typeof DeciderKind>;

/** A fast path: when this holds, propose this typed action without asking a model or a person. */
export const DecisionRule = z.object({
  id: z.string(),
  case: z.enum(CASE_KINDS),
  when: Cel,
  action: z.record(z.string(), z.unknown()),
  reason: z.string(),
});

/** Who may resolve a case, up to what size. Rules run first, the model next, people last. */
export const Decisions = z.object({
  deciders: z.array(DeciderKind).min(1).default(['rules', 'model', 'person']),
  /**
   * Hard ceiling per currency, in minor units, set by the tenant. Anything larger, or in a
   * currency with no entry, goes straight to a person.
   */
  ceiling: z.record(z.string(), z.int().positive()).default({}),
  rules: z.array(DecisionRule).default([]),
  limits: DecisionLimits.default(DecisionLimits.parse({})),
  /** Whether agents get the whole ceiling at once, or have to earn it. */
  autonomy: Autonomy.default({ mode: 'fixed' }),
  /** How many proposals a model may make on one case, each after code refused the last. */
  modelAttempts: z.int().min(1).max(5).default(2),
  timeout: Duration.default('48h'),
  /** What happens to a frozen deal if nobody decides in time. */
  onTimeout: z.enum(['cancel', 'proceed']).default('cancel'),
});

/** The tenant's ceiling in one currency. A currency with no entry has none: nothing is automated. */
export const ceilingIn = (decisions: Pick<Decisions, 'ceiling'>, currency: string): number =>
  decisions.ceiling[currency] ?? 0;

/** Whether an agent looks at a scheduled cycle before it runs, and may hold it back. */
export const Treasury = z.discriminatedUnion('mode', [
  z.object({ mode: z.literal('off') }),
  z.object({
    mode: z.literal('agent'),
    /** How many cycles in a row can be held. After that it settles, whatever the view. */
    maxDeferrals: z.int().min(1).max(10).default(2),
    /** A rate move smaller than this, with everyone funded, is not worth asking about. */
    reviewMoveBps: Bps.default(50),
  }),
]);

/** What the open-position monitor watches. */
export const Monitor = z.object({
  /** Rejected deals in a day that put an agent under review. */
  agentRejectionsPerDay: z.int().min(1).default(5),
});

/** The tunable part of a program. Overrides patch these fields. */
export const PolicyCore = z.object({
  authority: Authority.default(Authority.parse({})),
  funding: Funding,
  margin: Margin.default({ mode: 'none' }),
  marginUse: MarginUse.default(MarginUse.parse({})),
  portfolioMargin: PortfolioMargin.default({ mode: 'none' }),
  risk: Risk.default(Risk.parse({})),
  checks: z.array(Check).default([]),
  release: Release,
  settlement: Settlement,
  treasury: Treasury.default({ mode: 'off' }),
  decisions: Decisions.default(Decisions.parse({})),
  monitor: Monitor.default(Monitor.parse({})),
  fees: Fees.optional(),
});
export type PolicyCore = z.infer<typeof PolicyCore>;

export const Override = z.object({
  id: z.string(),
  when: Cel,
  /** Deep-merged into the policy. Arrays replace rather than merge. */
  set: z.record(z.string(), z.unknown()),
  reason: z.string(),
});

/** A clearing program: a named, versioned template a tenant applies to deals. */
export const ProgramSpec = PolicyCore.extend({
  name: z.string(),
  dealShape: DealShapePolicy.default(DealShapePolicy.parse({})),
  description: z.string().optional(),
  /** Signal providers resolved before rules run; exposed to CEL as `signals.<name>`. */
  signals: z.array(z.string()).default([]),
  overrides: z.array(Override).default([]),
});
export type ProgramSpec = z.infer<typeof ProgramSpec>;
export type ProgramSpecInput = z.input<typeof ProgramSpec>;

export type Decisions = z.infer<typeof Decisions>;
export type Funding = z.infer<typeof Funding>;
export type Margin = z.infer<typeof Margin>;
export type Release = z.infer<typeof Release>;
export type AmountRule = z.infer<typeof AmountRule>;
export type Check = z.infer<typeof Check>;
