import { z } from 'zod';
import { validateCel } from './cel.ts';
import { Duration } from './duration.ts';

const Cel = z.string().superRefine((expr, ctx) => {
  const err = validateCel(expr);
  if (err) ctx.addIssue({ code: 'custom', message: err });
});
const Bps = z.int().min(0).max(10_000);

// ── Conditions: when may held funds be released? ───────────────────────────

export const DocumentMatch = z.object({
  /** Accept a shipment this many days after the agreed date. */
  shipmentDateLateDays: z.int().min(0).default(0),
  quantityTolerancePct: z.number().min(0).default(0),
  amountTolerancePct: z.number().min(0).default(0),
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
    // Built-ins without params, and custom condition types registered in code.
    z.looseObject({ type: z.string() }),
  ]),
) as z.ZodType<ConditionNode>;

export const AmountRule = z.discriminatedUnion('type', [
  z.object({ type: z.literal('full') }),
  /** Pay only for the share that passed inspection. */
  z.object({ type: z.literal('pro_rata_inspection') }),
  z.object({ type: z.literal('cel'), expr: Cel }),
]);

// ── Program building blocks ────────────────────────────────────────────────

export const Funding = z.discriminatedUnion('mode', [
  /** Buyer locks the full amount when the deal is accepted. */
  z.object({ mode: z.literal('prefunded'), timeout: Duration.default('72h') }),
  /** Buyer locks a share up front; the rest is collected at settlement. */
  z.object({ mode: z.literal('partial'), bps: Bps, timeout: Duration.default('72h') }),
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
});

export const Settlement = z.object({
  netting: z.enum(['multilateral', 'bilateral', 'gross']).default('multilateral'),
  rail: z.string().default('mock'),
});

export const Authority = z.object({
  enforceMandate: z.boolean().default(true),
  /** Extra authority rules; each must be true for the deal to proceed. */
  rules: z.array(z.object({ when: Cel, reason: z.string() })).default([]),
});

export const Approvals = z.object({
  timeout: Duration.default('48h'),
  onTimeout: z.enum(['cancel', 'proceed']).default('cancel'),
});

/** The tunable part of a program. Overrides patch these fields. */
export const PolicyCore = z.object({
  authority: Authority.default({ enforceMandate: true, rules: [] }),
  funding: Funding,
  margin: Margin.default({ mode: 'none' }),
  checks: z.array(Check).default([]),
  release: Release,
  settlement: Settlement.default({ netting: 'multilateral', rail: 'mock' }),
  approvals: Approvals.default({ timeout: '48h', onTimeout: 'cancel' }),
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
  description: z.string().optional(),
  /** Signal providers resolved before rules run; exposed to CEL as `signals.<name>`. */
  signals: z.array(z.string()).default([]),
  overrides: z.array(Override).default([]),
});
export type ProgramSpec = z.infer<typeof ProgramSpec>;
export type ProgramSpecInput = z.input<typeof ProgramSpec>;

export type Funding = z.infer<typeof Funding>;
export type Margin = z.infer<typeof Margin>;
export type Release = z.infer<typeof Release>;
export type AmountRule = z.infer<typeof AmountRule>;
export type Check = z.infer<typeof Check>;
