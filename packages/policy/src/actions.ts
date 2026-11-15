import { DealLine } from '@novate/core';
import { z } from 'zod';

/**
 * The fixed vocabulary of the agent layer. A model, a rule or a person picks one of these; code
 * validates it against the program's limits before anything moves. Nothing else can change a deal.
 */
export const CASE_KINDS = [
  'frozen',
  'held',
  'exception',
  'margin_review',
  'margin_breach',
  'agent_review',
  'settlement_exception',
  'recon_break',
  'treasury_review',
] as const;
export const CaseKind = z.enum(CASE_KINDS);
export type CaseKind = z.infer<typeof CaseKind>;

const Minor = z.string().regex(/^\d{1,16}$/);
const Id = z.string().min(1);
export const Bps = z.int().min(0).max(10_000);

export const Action = z.discriminatedUnion('type', [
  // Mistake review
  z.object({ type: z.literal('confirm') }),
  z.object({ type: z.literal('cancel') }),
  z.object({ type: z.literal('reprice'), lines: z.array(DealLine).min(1) }),
  // Evidence review
  /** Accept the listed findings, or every waivable open finding when omitted. */
  z.object({ type: z.literal('waive'), codes: z.array(z.string()).optional() }),
  z.object({ type: z.literal('request_evidence'), note: z.string().min(1) }),
  z.object({ type: z.literal('release_full') }),
  z.object({ type: z.literal('release_partial'), bps: Bps }),
  z.object({ type: z.literal('refund') }),
  z.object({ type: z.literal('draw_margin'), amount: Minor, reason: z.string().min(1) }),
  // Open-position management
  z.object({ type: z.literal('resize_margin'), bps: Bps }),
  z.object({ type: z.literal('margin_call'), amount: Minor }),
  z.object({ type: z.literal('extend_call') }),
  z.object({ type: z.literal('declare_default') }),
  z.object({ type: z.literal('suspend_agent'), agentId: Id }),
  z.object({ type: z.literal('reinstate_agent'), agentId: Id }),
  // Settlement
  z.object({ type: z.literal('retry_settlement') }),
  z.object({ type: z.literal('exclude_member'), memberId: Id }),
  /** Models never invent a plan; they choose one that code has already generated and priced. */
  z.object({ type: z.literal('choose_plan'), planId: Id }),
  // Operations
  z.object({ type: z.literal('halt_settlement') }),
  z.object({ type: z.literal('acknowledge'), note: z.string().min(1) }),
  z.object({ type: z.literal('no_action') }),
  z.object({ type: z.literal('escalate'), note: z.string().min(1) }),
]);
export type Action = z.infer<typeof Action>;
export type ActionType = Action['type'];

export const ALLOWED_ACTIONS: Record<CaseKind, readonly ActionType[]> = {
  frozen: ['confirm', 'cancel', 'reprice', 'escalate'],
  held: [
    'waive',
    'request_evidence',
    'release_full',
    'release_partial',
    'refund',
    'draw_margin',
    'escalate',
  ],
  exception: ['refund', 'escalate'],
  margin_review: ['resize_margin', 'margin_call', 'no_action', 'escalate'],
  margin_breach: ['extend_call', 'declare_default', 'escalate'],
  agent_review: ['suspend_agent', 'reinstate_agent', 'no_action', 'escalate'],
  settlement_exception: ['retry_settlement', 'exclude_member', 'choose_plan', 'escalate'],
  recon_break: ['halt_settlement', 'acknowledge', 'escalate'],
  treasury_review: ['choose_plan', 'escalate'],
};

export const DecisionLimits = z.object({
  /** How far a non-person may raise a deal's value when repricing. */
  maxRepriceIncreaseBps: Bps.default(0),
  /** The lowest share of the original value a non-person may reprice a deal to. */
  minRepriceBps: Bps.default(5_000),
  /** The smallest share of a deal a non-person may pay out through a partial release. */
  minPartialReleaseBps: Bps.default(5_000),
  /** Releasing past unmet conditions is for people unless a tenant opts in. */
  allowForceRelease: z.boolean().default(false),
  allowRefund: z.boolean().default(false),
  /** Finding codes a non-person may waive. `*` matches any run of characters. */
  waivableCodes: z.array(z.string()).default(['*']),
  /** Largest margin a non-person may set, and its largest single margin draw. */
  maxMarginBps: Bps.default(3_000),
  maxDrawBps: Bps.default(0),
});
export type DecisionLimits = z.infer<typeof DecisionLimits>;

export type DeciderType = 'rule' | 'model' | 'person';

export interface OpenFinding {
  code: string;
  waivable: boolean;
}

/** The facts code needs to judge a proposal. Built from the database, never from the proposer. */
export interface ActionContext {
  kind: CaseKind;
  decider: DeciderType;
  amount: bigint;
  currency: string;
  ceiling: Record<string, number>;
  limits: DecisionLimits;
  findings?: OpenFinding[];
  marginPosted?: bigint;
  newAmount?: bigint;
  planIds?: string[];
  memberIds?: string[];
  agentIds?: string[];
  /** On a reserve being lowered: agents may not go below what the numbers support. */
  marginFloorBps?: number;
  /** How many more goes this case's process allows, where the process is bounded. */
  attemptsLeft?: number;
}

const glob = (pattern: string) =>
  new RegExp(`^${pattern.replace(/[.+?^${}()|[\]\\]/g, '\\$&').replaceAll('*', '.*')}$`);

export const withinCeiling = (
  amount: bigint,
  currency: string,
  ceiling: Record<string, number>,
) => {
  const limit = ceiling[currency];
  return limit !== undefined && amount <= BigInt(limit);
};

/** Deterministic gate. An empty result means the action may run; anything else is a refusal. */
export function validateAction(ctx: ActionContext, action: Action): string[] {
  const violations: string[] = [];
  if (!ALLOWED_ACTIONS[ctx.kind].includes(action.type)) {
    return [`${action.type} is not allowed on a ${ctx.kind} case`];
  }
  const automated = ctx.decider !== 'person';
  if (
    automated &&
    action.type !== 'escalate' &&
    !withinCeiling(ctx.amount, ctx.currency, ctx.ceiling)
  ) {
    violations.push(`${ctx.amount} ${ctx.currency} is above the program ceiling`);
  }

  switch (action.type) {
    case 'reprice': {
      const to = ctx.newAmount;
      if (to === undefined || to <= 0n) violations.push('reprice must produce a positive amount');
      else if (automated) {
        const cap = ctx.amount + (ctx.amount * BigInt(ctx.limits.maxRepriceIncreaseBps)) / 10_000n;
        if (to > cap) violations.push(`reprice to ${to} exceeds the allowed ${cap}`);
        const floor = (ctx.amount * BigInt(ctx.limits.minRepriceBps)) / 10_000n;
        if (to < floor) violations.push(`reprice to ${to} is below the allowed ${floor}`);
        if (!withinCeiling(to, ctx.currency, ctx.ceiling)) {
          violations.push(`reprice to ${to} is above the program ceiling`);
        }
      }
      break;
    }
    case 'waive': {
      const open = ctx.findings ?? [];
      const codes = action.codes ?? open.filter((f) => f.waivable).map((f) => f.code);
      if (!codes.length) violations.push('there is nothing waivable to waive');
      const allowed = ctx.limits.waivableCodes.map(glob);
      for (const code of codes) {
        const finding = open.find((f) => f.code === code);
        if (!finding) violations.push(`${code} is not an open finding`);
        else if (!finding.waivable) violations.push(`${code} cannot be waived`);
        else if (automated && !allowed.some((re) => re.test(code))) {
          violations.push(`${code} is outside what this program lets agents waive`);
        }
      }
      break;
    }
    case 'release_full':
      if (automated && !ctx.limits.allowForceRelease) {
        violations.push('force release is reserved for people on this program');
      }
      break;
    case 'release_partial':
      if (automated && !ctx.limits.allowForceRelease) {
        violations.push('releasing past unmet conditions is reserved for people on this program');
      }
      if (automated && action.bps < ctx.limits.minPartialReleaseBps) {
        violations.push(`partial release below ${ctx.limits.minPartialReleaseBps}bps`);
      }
      break;
    case 'refund':
      if (automated && !ctx.limits.allowRefund) {
        violations.push('refunds are reserved for people on this program');
      }
      break;
    case 'draw_margin': {
      const posted = ctx.marginPosted ?? 0n;
      const amount = BigInt(action.amount);
      if (amount <= 0n) violations.push('a margin draw must be positive');
      if (amount > posted) violations.push(`draw ${amount} exceeds posted margin ${posted}`);
      if (automated && amount > (posted * BigInt(ctx.limits.maxDrawBps)) / 10_000n) {
        violations.push('draw exceeds the share of margin agents may take');
      }
      break;
    }
    case 'resize_margin':
      if (automated && action.bps > ctx.limits.maxMarginBps) {
        violations.push(`margin ${action.bps}bps exceeds the ${ctx.limits.maxMarginBps}bps limit`);
      }
      if (automated && ctx.marginFloorBps !== undefined && action.bps < ctx.marginFloorBps) {
        violations.push(`margin ${action.bps}bps is below the ${ctx.marginFloorBps}bps supported`);
      }
      break;
    case 'margin_call': {
      const amount = BigInt(action.amount);
      if (amount <= 0n) violations.push('a margin call must be positive');
      if (automated && amount > (ctx.amount * BigInt(ctx.limits.maxMarginBps)) / 10_000n) {
        violations.push(`margin call exceeds the ${ctx.limits.maxMarginBps}bps limit`);
      }
      break;
    }
    case 'extend_call':
    case 'retry_settlement':
      if (ctx.attemptsLeft === 0)
        violations.push('no attempts are left, so retrying has no effect');
      break;
    case 'choose_plan':
      if (!ctx.planIds?.includes(action.planId)) {
        violations.push(`${action.planId} is not one of the generated plans`);
      }
      break;
    case 'exclude_member':
      if (!ctx.memberIds?.includes(action.memberId)) {
        violations.push(`${action.memberId} is not part of this cycle`);
      }
      break;
    case 'suspend_agent':
    case 'reinstate_agent':
      if (!ctx.agentIds?.includes(action.agentId)) {
        violations.push(`${action.agentId} is not the agent under review`);
      }
      break;
  }
  return violations;
}

/** The result of a model or rule considering a case. */
export interface Proposal {
  action: Action;
  rationale: string;
  metadata?: Record<string, unknown>;
}

/** What a decider sees. The binding hash covers exactly this content. */
export interface CaseView {
  caseId: string;
  kind: CaseKind;
  reason: string;
  bindingHash: string;
  shown: Record<string, unknown>;
  allowedActions: readonly ActionType[];
}

/** What a model hands back. The gateway parses `action` before it counts for anything. */
export interface UntrustedProposal extends Omit<Proposal, 'action'> {
  action: unknown;
}

/** A model-backed decider. Implementations live in `@novate/agents`. */
export interface DecisionAgent {
  readonly name: string;
  decide(view: CaseView, priorViolations: string[]): Promise<UntrustedProposal>;
}

/**
 * Ask until a proposal is accepted. Refusals go back to the proposer so it can choose differently.
 * `apply` returns the refusals, or the result of an accepted proposal. Null means nothing was
 * accepted, or the proposer escalated, and the case moves on to the next decider.
 */
export async function firstAccepted<R>(
  attempts: number,
  propose: (priorViolations: string[]) => Promise<UntrustedProposal>,
  apply: (proposal: Proposal) => Promise<R | string[]>,
): Promise<R | null> {
  let prior: string[] = [];
  for (let i = 0; i < attempts; i++) {
    const proposal = await propose(prior);
    const parsed = Action.safeParse(proposal.action);
    if (!parsed.success) {
      prior = [`not a valid action: ${parsed.error.issues[0]?.message ?? 'invalid'}`];
      continue;
    }
    const clean = { ...proposal, action: parsed.data };
    const out = await apply(clean);
    if (!Array.isArray(out)) return out;
    if (clean.action.type === 'escalate') return null;
    prior = out;
  }
  return null;
}
