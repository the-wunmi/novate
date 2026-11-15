import { DealLine, type DeciderType, type RecordMetadata, toMajor } from '@novate/core';
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

const ALLOWED_ACTIONS: Record<Exclude<CaseKind, 'exception'>, readonly ActionType[]> = {
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
  margin_review: ['resize_margin', 'margin_call', 'no_action', 'escalate'],
  margin_breach: ['extend_call', 'declare_default', 'escalate'],
  agent_review: ['suspend_agent', 'reinstate_agent', 'no_action', 'escalate'],
  settlement_exception: ['retry_settlement', 'exclude_member', 'choose_plan', 'escalate'],
  recon_break: ['halt_settlement', 'acknowledge', 'escalate'],
  treasury_review: ['choose_plan', 'escalate'],
};

/** Who filed the claim an exception case is about. Each side has its own remedy. */
export type Claimant = 'buyer' | 'seller';

/**
 * A claim after settlement is granted with the claimant's own remedy only: a buyer's with a refund,
 * a seller's short payment with `release_full`.
 */
const CLAIM_ACTIONS: Record<Claimant, readonly ActionType[]> = {
  buyer: ['refund', 'escalate'],
  seller: ['release_full', 'escalate'],
};

/** What a decider may choose on a case. */
export function allowedActions(kind: CaseKind, claimant?: Claimant): readonly ActionType[] {
  return kind === 'exception' ? CLAIM_ACTIONS[claimant ?? 'buyer'] : ALLOWED_ACTIONS[kind];
}

export const DecisionLimits = z.object({
  /** How far a non-person may raise a deal's value when repricing. */
  maxRepriceIncreaseBps: Bps.default(0),
  /** The lowest share of the original value a non-person may reprice a deal to. */
  minRepriceBps: Bps.default(5_000),
  /** The smallest share of a deal a non-person may pay out through a partial release. */
  minPartialReleaseBps: Bps.default(5_000),
  /** Releasing past unmet conditions is for people unless a tenant opts in. */
  allowForceRelease: z.boolean().default(false),
  /** Refunds, and granting either side's claim after settlement, are for people unless opted in. */
  allowRefund: z.boolean().default(false),
  /** Finding codes a non-person may waive. `*` matches any run of characters. */
  waivableCodes: z.array(z.string()).default(['*']),
  /** Largest margin a non-person may set, and its largest single margin draw. */
  maxMarginBps: Bps.default(3_000),
  maxDrawBps: Bps.default(0),
});
export type DecisionLimits = z.infer<typeof DecisionLimits>;

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
  /** On a claim after settlement: who filed it. */
  claimant?: Claimant;
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

/** Stable names for the checks, for anything that reads them other than a person. */
export type CheckCode =
  | 'allowed_action'
  | 'ceiling'
  | 'reprice_cap'
  | 'reprice_floor'
  | 'reprice_positive'
  | 'waivable'
  | 'open_finding'
  | 'program_allows_waive'
  | 'force_release'
  | 'partial_release_min'
  | 'refund'
  | 'draw_positive'
  | 'draw_within_posted'
  | 'draw_share'
  | 'margin_max'
  | 'margin_floor'
  | 'call_positive'
  | 'call_max'
  | 'attempts_left'
  | 'plan_generated'
  | 'member_in_cycle'
  | 'agent_under_review'
  | 'person_only'
  | 'evidence_unchanged';

/** One rule code applied to a proposal, and whether the proposal met it. */
export interface ActionCheck {
  code: CheckCode;
  /**
   * What the rule was judged on, where the code alone does not say: the action, a finding, the
   * amounts (minor units) and basis points compared. `describeCheck` words it from these.
   */
  params?: Record<string, string>;
  passed: boolean;
  /** For a limit on money: what was asked and what is allowed, in minor units. */
  measure?: { amount: string; limit: string | null; currency: string };
}

/**
 * Every rule that applies to this proposal, passed or not, so a record can show what code checked.
 * `validateAction` is the same judgement reduced to its refusals.
 */
export function checkAction(ctx: ActionContext, action: Action): ActionCheck[] {
  const checks: ActionCheck[] = [];
  const rule = (
    code: CheckCode,
    passed: boolean,
    params?: Record<string, string | bigint | number>,
    measure?: ActionCheck['measure'],
  ) =>
    checks.push({
      code,
      ...(params
        ? { params: Object.fromEntries(Object.entries(params).map(([k, v]) => [k, String(v)])) }
        : {}),
      passed,
      ...(measure ? { measure } : {}),
    });

  const allowed = allowedActions(ctx.kind, ctx.claimant).includes(action.type);
  rule('allowed_action', allowed, { action: action.type, kind: ctx.kind });
  if (!allowed) return checks;

  const automated = ctx.decider !== 'person';
  if (automated && action.type !== 'escalate') {
    const limit = ctx.ceiling[ctx.currency];
    rule('ceiling', withinCeiling(ctx.amount, ctx.currency, ctx.ceiling), undefined, {
      amount: ctx.amount.toString(),
      limit: limit === undefined ? null : String(limit),
      currency: ctx.currency,
    });
  }

  const currency = ctx.currency;
  switch (action.type) {
    case 'reprice': {
      const to = ctx.newAmount;
      rule('reprice_positive', to !== undefined && to > 0n);
      if (to === undefined || to <= 0n || !automated) break;
      const cap = ctx.amount + (ctx.amount * BigInt(ctx.limits.maxRepriceIncreaseBps)) / 10_000n;
      rule('reprice_cap', to <= cap, { amount: to, limit: cap, currency });
      const floor = (ctx.amount * BigInt(ctx.limits.minRepriceBps)) / 10_000n;
      rule('reprice_floor', to >= floor, { amount: to, limit: floor, currency });
      rule('ceiling', withinCeiling(to, currency, ctx.ceiling), { amount: to, currency });
      break;
    }
    case 'waive': {
      const open = ctx.findings ?? [];
      const codes = action.codes ?? open.filter((f) => f.waivable).map((f) => f.code);
      rule('waivable', codes.length > 0);
      const allowedCodes = ctx.limits.waivableCodes.map(glob);
      for (const code of codes) {
        const finding = open.find((f) => f.code === code);
        rule('open_finding', Boolean(finding), { finding: code });
        if (!finding) continue;
        rule('waivable', finding.waivable, { finding: code });
        if (finding.waivable && automated) {
          rule(
            'program_allows_waive',
            allowedCodes.some((re) => re.test(code)),
            { finding: code },
          );
        }
      }
      break;
    }
    case 'release_full':
    case 'release_partial':
      // After settlement a seller's claim is paid from the buyer, a refund the other way round.
      if (ctx.kind === 'exception') {
        if (automated) rule('refund', ctx.limits.allowRefund, { action: action.type });
        break;
      }
      if (automated) {
        rule('force_release', ctx.limits.allowForceRelease, { action: action.type });
        if (action.type === 'release_partial') {
          rule('partial_release_min', action.bps >= ctx.limits.minPartialReleaseBps, {
            bps: action.bps,
            limit: ctx.limits.minPartialReleaseBps,
          });
        }
      }
      break;
    case 'refund':
      if (automated) rule('refund', ctx.limits.allowRefund);
      break;
    case 'draw_margin': {
      const posted = ctx.marginPosted ?? 0n;
      const amount = BigInt(action.amount);
      rule('draw_positive', amount > 0n);
      rule('draw_within_posted', amount <= posted, { amount, limit: posted });
      if (automated) {
        rule('draw_share', amount <= (posted * BigInt(ctx.limits.maxDrawBps)) / 10_000n, {
          limit: ctx.limits.maxDrawBps,
        });
      }
      break;
    }
    case 'resize_margin':
      if (automated) {
        rule('margin_max', action.bps <= ctx.limits.maxMarginBps, {
          bps: action.bps,
          limit: ctx.limits.maxMarginBps,
        });
        if (ctx.marginFloorBps !== undefined) {
          rule('margin_floor', action.bps >= ctx.marginFloorBps, {
            bps: action.bps,
            limit: ctx.marginFloorBps,
          });
        }
      }
      break;
    case 'margin_call': {
      const amount = BigInt(action.amount);
      rule('call_positive', amount > 0n);
      if (automated) {
        rule('call_max', amount <= (ctx.amount * BigInt(ctx.limits.maxMarginBps)) / 10_000n, {
          limit: ctx.limits.maxMarginBps,
        });
      }
      break;
    }
    case 'extend_call':
    case 'retry_settlement':
      if (ctx.attemptsLeft !== undefined) rule('attempts_left', ctx.attemptsLeft !== 0);
      break;
    case 'choose_plan':
      rule('plan_generated', Boolean(ctx.planIds?.includes(action.planId)), {
        plan: action.planId,
      });
      break;
    case 'exclude_member':
      rule('member_in_cycle', Boolean(ctx.memberIds?.includes(action.memberId)), {
        member: action.memberId,
      });
      break;
    case 'acknowledge':
      // Client money that does not add up is a person's call to accept. Agents may only stop.
      if (ctx.kind === 'recon_break') rule('person_only', !automated);
      break;
    case 'suspend_agent':
    case 'reinstate_agent':
      rule('agent_under_review', Boolean(ctx.agentIds?.includes(action.agentId)), {
        agent: action.agentId,
      });
      break;
  }
  return checks;
}

/** A check in words: the rule it applied, or why the proposal failed it. */
export function describeCheck(check: ActionCheck): string {
  const p = check.params ?? {};
  const money = (key: string) =>
    p.currency ? `${toMajor(BigInt(p[key] ?? 0), p.currency)} ${p.currency}` : String(p[key]);
  const [rule, failed] = ((): [string, string] => {
    switch (check.code) {
      case 'allowed_action':
        return [
          `${p.action} is one of the actions allowed on a ${p.kind} case`,
          `${p.action} is not allowed on a ${p.kind} case`,
        ];
      case 'ceiling': {
        const m = check.measure;
        const asked = m
          ? `${toMajor(BigInt(m.amount), m.currency)} ${m.currency}`
          : money('amount');
        return [
          'the amount is within the ceiling for automated decisions',
          `${asked} is above the program ceiling`,
        ];
      }
      case 'evidence_unchanged':
        return [
          'the evidence is unchanged since the decider was shown it',
          'the evidence has changed since this was shown',
        ];
      case 'reprice_positive':
        return ['the new price is positive', 'reprice must produce a positive amount'];
      case 'reprice_cap':
        return [
          `the new price is at most ${money('limit')}`,
          `reprice to ${money('amount')} exceeds the allowed ${money('limit')}`,
        ];
      case 'reprice_floor':
        return [
          `the new price is at least ${money('limit')}`,
          `reprice to ${money('amount')} is below the allowed ${money('limit')}`,
        ];
      case 'waivable':
        return p.finding
          ? [`${p.finding} can be waived`, `${p.finding} cannot be waived`]
          : ['there is something waivable to waive', 'there is nothing waivable to waive'];
      case 'open_finding':
        return [`${p.finding} is an open finding`, `${p.finding} is not an open finding`];
      case 'program_allows_waive':
        return [
          `this program lets agents waive ${p.finding}`,
          `${p.finding} is outside what this program lets agents waive`,
        ];
      case 'force_release':
        return p.action === 'release_partial'
          ? [
              'this program lets agents release past unmet conditions',
              'releasing past unmet conditions is reserved for people on this program',
            ]
          : [
              'this program lets agents force a release',
              'force release is reserved for people on this program',
            ];
      case 'partial_release_min':
        return [
          `the release is at least ${p.limit}bps`,
          `partial release of ${p.bps}bps is below ${p.limit}bps`,
        ];
      case 'refund':
        return p.action === 'release_full'
          ? [
              "this program lets agents pay a seller's claim",
              "paying a seller's claim is reserved for people on this program",
            ]
          : ['this program lets agents refund', 'refunds are reserved for people on this program'];
      case 'draw_positive':
        return ['the draw is positive', 'a margin draw must be positive'];
      case 'draw_within_posted':
        return [
          `the draw is within the ${p.limit} posted`,
          `draw ${p.amount} exceeds posted margin ${p.limit}`,
        ];
      case 'draw_share':
        return [
          `the draw is within the ${p.limit}bps of margin agents may take`,
          'draw exceeds the share of margin agents may take',
        ];
      case 'margin_max':
        return [
          `margin is at most ${p.limit}bps`,
          `margin ${p.bps}bps exceeds the ${p.limit}bps limit`,
        ];
      case 'margin_floor':
        return [
          `margin is at least the ${p.limit}bps the numbers support`,
          `margin ${p.bps}bps is below the ${p.limit}bps supported`,
        ];
      case 'call_positive':
        return ['the call is positive', 'a margin call must be positive'];
      case 'call_max':
        return [
          `the call is within the ${p.limit}bps limit`,
          `margin call exceeds the ${p.limit}bps limit`,
        ];
      case 'attempts_left':
        return ['attempts are left', 'no attempts are left, so retrying has no effect'];
      case 'plan_generated':
        return ['the plan is one code generated', `${p.plan} is not one of the generated plans`];
      case 'member_in_cycle':
        return ['the member is part of this cycle', `${p.member} is not part of this cycle`];
      case 'person_only':
        return [
          'only a person may acknowledge a difference in client money',
          'acknowledging a reconciliation difference is reserved for a person',
        ];
      case 'agent_under_review':
        return ['the agent is the one under review', `${p.agent} is not the agent under review`];
    }
  })();
  return check.passed ? rule : failed;
}

/** Why a proposal was refused, one line per failed check. Empty when it passed them all. */
export const refusalsOf = (checks: ActionCheck[]): string[] =>
  checks.filter((c) => !c.passed).map(describeCheck);

/** Deterministic gate. An empty result means the action may run; anything else is a refusal. */
export function validateAction(ctx: ActionContext, action: Action): string[] {
  return refusalsOf(checkAction(ctx, action));
}

/** The result of a model or rule considering a case. */
export interface Proposal {
  action: Action;
  rationale: string;
  metadata?: RecordMetadata;
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
