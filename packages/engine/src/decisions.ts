import { DBOS } from '@dbos-inc/dbos-sdk';
import {
  type CaseDecision,
  type ControlActor,
  type Decider,
  DomainError,
  dealAmount,
  describePrincipal,
  mayDecideCase,
  type Principal,
  parseInput,
  sha256,
  toJson,
} from '@novate/core';
import { dealFacts, decisionCases, decisionRecords, type Tx } from '@novate/db';
import {
  Action,
  type ActionCheck,
  type ActionContext,
  allowedActions,
  type CaseKind,
  type CaseView,
  type Claimant,
  ceilingIn,
  checkAction,
  type DeciderKind,
  type DecisionAgent,
  type Decisions,
  durationMs,
  evalCelBool,
  firstAccepted,
  type OpenFinding,
  type Proposal,
  refusalsOf,
  type UntrustedProposal,
  withinCeiling,
} from '@novate/policy';
import { asc, count, eq } from 'drizzle-orm';
import { z } from 'zod';
import { actorOf, personOf } from './control.ts';
import { deps, isWorkflowControl, paced, tx } from './deps.ts';
import {
  APPROVAL_TTL_MS,
  type PendingApproval,
  registerApprovalExecutor,
  requestApproval,
} from './four-eyes.ts';
import { notify } from './notifications.ts';
import { type DealRow, decidedAction, getDeal, inTenant } from './repo.ts';
import { Topics } from './topics.ts';
import { modelCeilingFor } from './track-record.ts';

export interface CaseSpec {
  tenantId: string;
  kind: CaseKind;
  subjectType: 'deal' | 'member' | 'agent' | 'cycle' | 'rail' | 'group';
  subjectId: string;
  dealId?: string;
  reason: string;
  /** JSON-safe detail shown to the decider and covered by the binding hash. */
  evidence: Record<string, unknown>;
  amount: bigint;
  currency: string;
  decisions: Decisions;
  findings?: OpenFinding[];
  marginPosted?: bigint;
  marginFloorBps?: number;
  planIds?: string[];
  memberIds?: string[];
  agentIds?: string[];
  attemptsLeft?: number;
  /** Values rules can read in CEL, beyond `deal`, `kind`, `findings`. */
  ruleVars?: Record<string, unknown>;
  /** Cases that must not block the workflow on a person (cycles, monitors). */
  skipPerson?: boolean;
  /** The workflow waiting on this case, where that is not the deal's own, such as a claim. */
  workflowId?: string;
  /** On a claim after settlement: who filed it, which decides the remedy a decider may grant. */
  claimant?: Claimant;
}

export type CaseResolution =
  | { outcome: 'decided'; caseId: string; action: Action; decider: Decider }
  | { outcome: 'expired'; caseId: string }
  | { outcome: 'stale'; caseId: string };

export type CaseMessage =
  | { type: 'decided'; caseId: string }
  | { type: 'evidence_changed'; caseId: string };

type CaseRow = typeof decisionCases.$inferSelect;

interface StoredContext {
  amount: string;
  currency: string;
  decisions: Decisions;
  findings?: OpenFinding[];
  marginPosted?: string;
  marginFloorBps?: number;
  /** What a model may decide up to, which may be less than the tenant's ceiling. */
  modelCeiling: Record<string, number>;
  planIds?: string[];
  memberIds?: string[];
  agentIds?: string[];
  attemptsLeft?: number;
  evidence: Record<string, unknown>;
  subject: { type: string; id: string };
  workflowId?: string;
  claimant?: Claimant;
}

const contextOf = (row: CaseRow) => row.context as unknown as StoredContext;

/** A case as read models show it, with the context it was opened with. */
export const caseView = (row: CaseRow) => ({ ...row, context: contextOf(row) });

/** Large enough for any real document's fields, small enough that a party cannot run up the bill. */
const MAX_SHOWN_FACT_CHARS = 20_000;
/** Parties can file many facts, so the whole case has a limit too. */
const MAX_SHOWN_FACTS_CHARS = 200_000;

/** Facts as a decider sees them. How each was extracted is bookkeeping, so that is left out. */
function shownFacts(facts: (typeof dealFacts.$inferSelect)[]) {
  let room = MAX_SHOWN_FACTS_CHARS;
  return facts.map((f) => {
    const { extraction: _extraction, ...data } = f.data;
    const size = JSON.stringify(data).length;
    const fits = size <= MAX_SHOWN_FACT_CHARS && size <= room;
    if (fits) room -= size;
    return {
      id: f.id,
      kind: f.kind,
      type: f.type,
      source: f.source,
      contentHash: sha256(f.data),
      ...(fits ? { data } : { omitted: 'too large to show' }),
    };
  });
}

/** Exactly what a decider sees. Rebuilt from current state to detect anything that has moved. */
async function buildShown(
  db: Tx,
  c: Pick<CaseRow, 'kind' | 'reason' | 'dealId'>,
  context: StoredContext,
): Promise<Record<string, unknown>> {
  const base = {
    kind: c.kind,
    reason: c.reason,
    subject: context.subject,
    evidence: context.evidence,
  };
  if (!c.dealId) return base;
  const deal = await getDeal(db, c.dealId);
  const facts = await db
    .select()
    .from(dealFacts)
    .where(eq(dealFacts.dealId, c.dealId))
    .orderBy(asc(dealFacts.createdAt), asc(dealFacts.id));
  return {
    ...base,
    deal: {
      id: deal.id,
      amount: deal.amount,
      currency: deal.currency,
      buyer: deal.buyerMemberId,
      seller: deal.sellerMemberId,
      terms: deal.terms,
    },
    facts: shownFacts(facts),
  };
}

async function openCase(
  db: Tx,
  spec: CaseSpec,
  modelCeiling: Record<string, number>,
): Promise<CaseRow> {
  const context = {
    amount: spec.amount,
    currency: spec.currency,
    decisions: spec.decisions,
    findings: spec.findings,
    marginPosted: spec.marginPosted,
    marginFloorBps: spec.marginFloorBps,
    modelCeiling,
    planIds: spec.planIds,
    memberIds: spec.memberIds,
    agentIds: spec.agentIds,
    attemptsLeft: spec.attemptsLeft,
    evidence: spec.evidence,
    subject: { type: spec.subjectType, id: spec.subjectId },
    workflowId: spec.workflowId,
    claimant: spec.claimant,
  } as unknown as StoredContext;
  const shown = await buildShown(db, { ...spec, dealId: spec.dealId ?? null }, context);
  const [row] = await db
    .insert(decisionCases)
    .values({
      tenantId: spec.tenantId,
      kind: spec.kind,
      subjectType: spec.subjectType,
      subjectId: spec.subjectId,
      dealId: spec.dealId,
      reason: spec.reason,
      bindingHash: sha256(shown),
      shown,
      context: context as unknown as Record<string, unknown>,
      // Hashed as stored, so the trail can show the limits the gate used have not moved.
      contextHash: sha256(JSON.parse(toJson(context))),
    })
    .returning();
  return row as CaseRow;
}

/** Who made a recorded proposal, as the gate judges it: the house acting on its own is a rule. */
export const recordedDecider = (
  r: Pick<typeof decisionRecords.$inferSelect, 'deciderType' | 'deciderId'>,
): Decider => ({ type: r.deciderType === 'system' ? 'rule' : r.deciderType, id: r.deciderId });

/** The facts an action is judged against. A replay can pass different limits to test them. */
export function actionContext(
  row: CaseRow,
  decider: Decider,
  action: Action,
  candidate?: Decisions,
): ActionContext {
  const c = contextOf(row);
  const decisions = candidate ?? c.decisions;
  return {
    kind: row.kind as CaseKind,
    decider: decider.type,
    amount: BigInt(c.amount),
    currency: c.currency,
    ceiling: decider.type === 'model' && !candidate ? c.modelCeiling : decisions.ceiling,
    limits: decisions.limits,
    findings: c.findings,
    marginPosted: c.marginPosted === undefined ? undefined : BigInt(c.marginPosted),
    marginFloorBps: c.marginFloorBps,
    newAmount: action.type === 'reprice' ? dealAmount({ lines: action.lines }) : undefined,
    planIds: c.planIds,
    memberIds: c.memberIds,
    agentIds: c.agentIds,
    attemptsLeft: c.attemptsLeft,
    claimant: c.claimant,
  };
}

async function lockCase(db: Tx, caseId: string): Promise<CaseRow> {
  const [row] = await db
    .select()
    .from(decisionCases)
    .where(eq(decisionCases.id, caseId))
    .for('update');
  if (!row) throw new DomainError('not_found', 'Case not found');
  return row;
}

interface ApplyResult {
  accepted: boolean;
  stale: boolean;
  violations: string[];
}

/** The one path by which a proposal becomes a decision. Validates, then records either way. */
async function applyProposal(
  db: Tx,
  row: CaseRow,
  decider: Decider,
  proposal: Proposal,
): Promise<ApplyResult> {
  const stale = sha256(await buildShown(db, row, contextOf(row))) !== row.bindingHash;
  const checks: ActionCheck[] = [
    { code: 'evidence_unchanged', passed: !stale },
    ...(stale ? [] : checkAction(actionContext(row, decider, proposal.action), proposal.action)),
  ];
  const violations = refusalsOf(checks);
  const accepted = violations.length === 0;

  await db.insert(decisionRecords).values({
    caseId: row.id,
    deciderType: decider.type,
    deciderId: decider.id,
    action: proposal.action,
    rationale: proposal.rationale,
    bindingHash: row.bindingHash,
    accepted: accepted ? 1 : 0,
    checks,
    metadata: proposal.metadata ?? {},
  });

  if (stale) {
    await db
      .update(decisionCases)
      .set({ status: 'stale', closedAt: new Date() })
      .where(eq(decisionCases.id, row.id));
  } else if (accepted && proposal.action.type !== 'escalate') {
    await db
      .update(decisionCases)
      .set({
        status: 'decided',
        closedAt: new Date(),
        resolution: { action: proposal.action, decider },
      })
      .where(eq(decisionCases.id, row.id));
  }
  return { accepted, stale, violations };
}

function ruleProposal(spec: CaseSpec, row: CaseRow): { id: string; proposal: Proposal } | null {
  const evidence = contextOf(row).evidence;
  const vars = {
    kind: spec.kind,
    amount: spec.amount,
    currency: spec.currency,
    findings: spec.findings ?? [],
    evidence,
    deal: { amount: spec.amount, currency: spec.currency },
    ...spec.ruleVars,
  };
  for (const rule of spec.decisions.rules) {
    if (rule.case !== spec.kind) continue;
    const parsed = Action.safeParse(fillTemplate(evidence, rule.action));
    if (parsed.success && ruleMatches(rule.when, vars)) {
      return { id: rule.id, proposal: { action: parsed.data, rationale: rule.reason } };
    }
  }
  return null;
}

/** A rule that cannot be evaluated does not apply. The case moves on to the next decider. */
function ruleMatches(when: string, vars: Record<string, unknown>): boolean {
  try {
    return evalCelBool(when, vars);
  } catch {
    return false;
  }
}

/** A rule's action can take values code computed: `{ "bps": "$targetBps" }` reads the evidence. */
function fillTemplate(evidence: Record<string, unknown>, action: Record<string, unknown>) {
  return Object.fromEntries(
    Object.entries(action).map(([k, v]) =>
      typeof v === 'string' && v.startsWith('$') ? [k, evidence[v.slice(1)]] : [k, v],
    ),
  );
}

const closeCase = (caseId: string, status: 'expired') =>
  tx(`case_${status}`, async (db) => {
    await db
      .update(decisionCases)
      .set({ status, closedAt: new Date() })
      .where(eq(decisionCases.id, caseId));
  });

const expire = async (caseId: string): Promise<CaseResolution> => {
  await closeCase(caseId, 'expired');
  return { outcome: 'expired', caseId };
};

/** Try a proposal. Returns a resolution if it settled the case, or the refusals if it did not. */
async function attempt(
  name: string,
  row: CaseRow,
  decider: Decider,
  proposal: Proposal,
): Promise<CaseResolution | string[]> {
  const applied = await tx(name, async (db) => {
    const current = await lockCase(db, row.id);
    return current.status === 'open' ? applyProposal(db, current, decider, proposal) : current;
  });
  // A person can decide while a model is thinking. Their decision stands.
  if ('status' in applied) return closedOutcome(applied);
  if (applied.stale) return { outcome: 'stale', caseId: row.id };
  if (applied.accepted && proposal.action.type !== 'escalate') {
    return { outcome: 'decided', caseId: row.id, action: proposal.action, decider };
  }
  return applied.violations;
}

function closedOutcome(row: CaseRow): CaseResolution {
  if (row.status === 'decided') return decidedOutcome(row);
  return { outcome: row.status === 'stale' ? 'stale' : 'expired', caseId: row.id };
}

async function askRules(spec: CaseSpec, row: CaseRow): Promise<CaseResolution | null> {
  const hit = ruleProposal(spec, row);
  if (!hit) return null;
  const out = await attempt('case_apply_rule', row, { type: 'rule', id: hit.id }, hit.proposal);
  return Array.isArray(out) ? null : out;
}

/** Each new fact can reopen a case, so a party must not be able to run up the model bill. */
const MAX_MODEL_CASES_PER_DEAL = 20;

const modelBudgetSpent = (row: CaseRow) =>
  tx('case_model_budget', async (db) => {
    if (!row.dealId) return false;
    const [used] = await db
      .select({ n: count() })
      .from(decisionCases)
      .where(eq(decisionCases.dealId, row.dealId));
    return (used?.n ?? 0) > MAX_MODEL_CASES_PER_DEAL;
  });

async function askModel(spec: CaseSpec, row: CaseRow): Promise<CaseResolution | null> {
  const agent = deps().decisionAgent;
  if (!agent || (await modelBudgetSpent(row))) return null;
  const view: CaseView = {
    caseId: row.id,
    kind: spec.kind,
    reason: spec.reason,
    bindingHash: row.bindingHash,
    shown: row.shown,
    allowedActions: allowedActions(spec.kind, spec.claimant),
  };
  try {
    return await firstAccepted(
      spec.decisions.modelAttempts,
      async (prior) => {
        const answer = await askAgent(agent, view, prior);
        if ('proposal' in answer) return answer.proposal;
        await tx('case_model_failed', (db) => recordModelFailure(db, row, answer.failure));
        throw new ModelOutage();
      },
      (proposal) => attempt('case_apply_model', row, answeredBy(agent, proposal), proposal),
    );
  } catch (err) {
    if (err instanceof ModelOutage) return null;
    throw err;
  }
}

interface ModelFailure {
  /** `refused`, `cut_off`, `malformed`, `configuration` or `unavailable`. Kept so each can be counted. */
  reason: string;
  note: string;
}

type ModelAnswer = { proposal: UntrustedProposal } | { failure: ModelFailure };

/** A failure the agent marks as final is returned, not thrown, so DBOS does not repeat the call. */
async function askAgent(
  agent: DecisionAgent,
  view: CaseView,
  prior: string[],
): Promise<ModelAnswer> {
  const ask = async (): Promise<ModelAnswer> => {
    try {
      return { proposal: await agent.decide(view, prior) };
    } catch (err) {
      const { retryable, reason, message } = err as Error & { retryable?: boolean; reason: string };
      if (retryable === false) return { failure: { reason, note: message } };
      throw err;
    }
  };
  try {
    return await DBOS.runStep(ask, {
      name: 'case_model',
      retriesAllowed: true,
      maxAttempts: 3,
      intervalSeconds: paced(1_000) / 1_000,
    });
  } catch (err) {
    if (isWorkflowControl(err)) throw err;
    return {
      failure: { reason: 'unavailable', note: `model unavailable: ${(err as Error).message}` },
    };
  }
}

/** The agent reports which model really answered, and the record must name that one. */
function answeredBy(agent: DecisionAgent, proposal: Proposal): Decider {
  return { type: 'model', id: proposal.metadata?.model ?? agent.name };
}

/** The model could not give an answer, and that has been recorded. The next decider takes the case. */
class ModelOutage extends Error {}

async function recordModelFailure(db: Tx, row: CaseRow, failure: ModelFailure) {
  await db.insert(decisionRecords).values({
    caseId: row.id,
    deciderType: 'system',
    deciderId: 'gateway',
    action: { type: 'escalate', note: failure.note },
    rationale: failure.note,
    bindingHash: row.bindingHash,
    accepted: 0,
    checks: [],
    metadata: { failure: failure.reason },
  });
}

/** The fields every case about a deal shares. */
export const dealCase = (
  deal: Pick<DealRow, 'id' | 'tenantId' | 'amount' | 'currency'>,
  decisions: Decisions,
  kind: CaseKind,
  reason: string,
  evidence: Record<string, unknown>,
  extra: Partial<CaseSpec> = {},
): CaseSpec => ({
  tenantId: deal.tenantId,
  kind,
  subjectType: 'deal',
  subjectId: deal.id,
  dealId: deal.id,
  reason,
  evidence,
  amount: deal.amount,
  currency: deal.currency,
  decisions,
  ...extra,
});

/**
 * Take a case through the program's deciders: rules first, then the model, then a person.
 * Anything too large goes straight to a person. A model outage or a refused proposal falls through.
 */
export async function resolveCase(spec: CaseSpec): Promise<CaseResolution> {
  const { row, modelCeiling } = await tx('case_open', async (db) => {
    const modelCeiling = await modelCeilingFor(db, { ...spec, dealId: spec.dealId ?? null });
    return { row: await openCase(db, spec, modelCeiling), modelCeiling };
  });
  const over = !withinCeiling(spec.amount, spec.currency, spec.decisions.ceiling);
  const pastEarnedLimit = !withinCeiling(spec.amount, spec.currency, modelCeiling);
  const chain: DeciderKind[] = over ? ['person'] : spec.decisions.deciders;

  // Over the ceiling and nobody can be waited on: it still has to reach a person.
  if (over && spec.skipPerson) await notifyPerson(spec, row);

  for (const decider of chain) {
    if (decider === 'person' && !spec.skipPerson) return awaitPerson(spec, row);
    if (decider === 'model' && pastEarnedLimit) {
      if (spec.skipPerson) await notifyPerson(spec, row);
      continue;
    }
    const answer =
      decider === 'rules'
        ? await askRules(spec, row)
        : decider === 'model'
          ? await askModel(spec, row)
          : null;
    if (answer) return answer;
  }
  return expire(row.id);
}

const readCase = (caseId: string) =>
  tx('case_read', async (db) => {
    const [row] = await db.select().from(decisionCases).where(eq(decisionCases.id, caseId));
    return row as CaseRow;
  });

function decidedOutcome(row: CaseRow): CaseResolution {
  const decider = (row.resolution as CaseDecision).decider;
  return { outcome: 'decided', caseId: row.id, action: decidedAction(row), decider };
}

const notifyPerson = (spec: CaseSpec, row: CaseRow) =>
  notify({
    type: 'case_needs_person',
    tenantId: spec.tenantId,
    caseId: row.id,
    kind: spec.kind,
    reason: spec.reason,
  });

/** Wait for a person. The database is the source of truth, so a lost message cannot lose a decision. */
async function awaitPerson(spec: CaseSpec, row: CaseRow): Promise<CaseResolution> {
  await notifyPerson(spec, row);
  const deadline = (await DBOS.now()) + durationMs(spec.decisions.timeout);
  while (true) {
    const now = await DBOS.now();
    const msg = await DBOS.recv<CaseMessage>(Topics.case, {
      deadlineEpochMS: Math.min(deadline, now + 60_000),
    });
    const current = await readCase(row.id);
    if (current.status === 'decided') return decidedOutcome(current);
    if (current.status === 'stale' || (msg?.type === 'evidence_changed' && msg.caseId === row.id)) {
      await tx('case_stale', (db) => markStale(db, current));
      return { outcome: 'stale', caseId: row.id };
    }
    if ((await DBOS.now()) >= deadline) return expire(row.id);
  }
}

const markStale = (db: Tx, row: CaseRow) =>
  db
    .update(decisionCases)
    .set({ status: 'stale', closedAt: row.closedAt ?? new Date() })
    .where(eq(decisionCases.id, row.id));

export const DecideCase = z.object({
  bindingHash: z.string(),
  action: Action,
  /** Why, in the person's words. Kept as the permanent record of the decision. */
  rationale: z.string().trim().min(1, 'A rationale is required').max(2_000),
});

/**
 * A person's decision. Same gate as agents, but people may exceed the automated limits. For the
 * house and the platform that person must be signed in: a key alone cannot say who decided. A
 * signed-in person deciding a case larger than the program's ceiling needs a second person's
 * approval, and the decision is applied only then, exactly once.
 */
export async function decideCase(
  caseId: string,
  principal: Principal,
  input: z.input<typeof DecideCase>,
): Promise<{ status: 'decided' } | PendingApproval> {
  const decision = parseInput(DecideCase, input);
  if (principal.kind === 'house' || principal.kind === 'platform') {
    personOf(principal, 'decide a case');
  }
  const out = await tx('decide_case', async (db) => {
    const row = await openCaseFor(db, caseId, principal, decision);
    const ctx = contextOf(row);
    const amount = BigInt(ctx.amount);
    const ceiling = BigInt(ceilingIn(ctx.decisions, ctx.currency));
    if (principal.userId && amount > ceiling) {
      return requestApproval(db, row.tenantId, principal, {
        kind: 'case_decision',
        payload: { caseId, principal: { ...principal }, ...decision },
        amount,
        currency: ctx.currency,
        reason: decision.rationale,
      });
    }
    return applyPersonDecision(db, row, principal, decision);
  });
  if ('status' in out) return out;
  await sendDecided(out);
  return { status: 'decided' };
}

/** The case, locked, if this principal may still decide it as it was shown. */
async function openCaseFor(
  db: Tx,
  caseId: string,
  principal: Principal,
  { bindingHash, action }: z.output<typeof DecideCase>,
): Promise<CaseRow> {
  const row = await lockCase(db, caseId);
  inTenant(row, principal.tenantId, 'Case');
  if (row.status !== 'open') throw new DomainError('conflict', `Case is ${row.status}`);
  const parties = row.dealId ? await getDeal(db, row.dealId) : null;
  if (!mayDecideCase(principal, parties, action.type)) {
    throw new DomainError('unauthorised_agent', 'Not allowed to take this action on this case');
  }
  if (bindingHash !== row.bindingHash) {
    throw new DomainError('conflict', 'Case no longer matches what was shown');
  }
  return row;
}

async function applyPersonDecision(
  db: Tx,
  row: CaseRow,
  principal: Principal,
  { action, rationale }: z.output<typeof DecideCase>,
  approval?: { approvalId: string; approvedBy: ControlActor },
) {
  const actor = actorOf(principal);
  const result = await applyProposal(
    db,
    row,
    { type: 'person', id: describePrincipal(principal), actor },
    { action, rationale, metadata: { actor, ...approval } },
  );
  if (!result.accepted && !result.stale) {
    throw new DomainError('invalid', result.violations.join('; '));
  }
  const waiting = contextOf(row).workflowId ?? row.dealId ?? row.subjectId;
  return { stale: result.stale, workflowId: waiting, caseId: row.id };
}

async function sendDecided(out: { stale: boolean; workflowId: string; caseId: string }) {
  const msg: CaseMessage = { type: 'decided', caseId: out.caseId };
  await DBOS.send(out.workflowId, msg, Topics.case, `case:${out.caseId}`);
  if (out.stale) throw new DomainError('conflict', 'Case no longer matches what was shown');
}

registerApprovalExecutor('case_decision', {
  approvers: ['house', 'platform'],
  ttlMs: APPROVAL_TTL_MS,
  async run(db, request, approvedBy) {
    const { caseId, principal, ...rest } = request.payload as {
      caseId: string;
      principal: Principal;
    };
    const decision = parseInput(DecideCase, rest);
    const row = await openCaseFor(db, caseId, principal, decision);
    const out = await applyPersonDecision(db, row, principal, decision, {
      approvalId: request.id,
      approvedBy,
    });
    // A stale case is recorded as such and the request is not approved: nothing was applied.
    if (out.stale) throw new DomainError('conflict', 'Case no longer matches what was shown');
    return out;
  },
  after: sendDecided,
});
