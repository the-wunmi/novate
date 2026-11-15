import { mkdirSync, writeFileSync } from 'node:fs';
import { parseArgs } from 'node:util';
import { dealAmount } from '@novate/core';
import {
  type Action,
  type ActionContext,
  ALLOWED_ACTIONS,
  type CaseView,
  DecisionLimits,
  firstAccepted,
  validateAction,
} from '@novate/policy';
import {
  ClaudeDecisionAgent,
  ClaudeDocumentReader,
  ClaudeModelClient,
  type ModelClient,
  type ModelReply,
  type ModelRequest,
} from '../src/index.ts';
import { type DecisionEval, decisionCases } from './decision-cases.ts';
import { type DocumentEval, documentCases } from './document-cases.ts';

const { values: args } = parseArgs({
  options: {
    trials: { type: 'string', default: '1' },
    only: { type: 'string', default: '' },
    concurrency: { type: 'string', default: '6' },
    /** Below this share correct, the run fails. Any harmful answer fails it regardless. */
    threshold: { type: 'string', default: '0.9' },
  },
});

const CEILING = { EUR: 20_000_000 };
/** Production gives a model this many tries after code refuses its proposal. */
const MODEL_ATTEMPTS = 2;

interface Outcome {
  id: string;
  group: string;
  trial: number;
  verdict: 'correct' | 'wrong' | 'harmful' | 'error';
  answer: string;
  problem?: string;
  rationale?: string;
  refusals: number;
}

const usage = { input: 0, output: 0, cacheRead: 0 };

/** Counts what a run costs, without the agents having to know they are being evaluated. */
function metered(model: ModelClient): ModelClient {
  return {
    model: model.model,
    async complete(request: ModelRequest): Promise<ModelReply> {
      const reply = await model.complete(request);
      usage.input += Number(reply.metadata.inputTokens ?? 0);
      usage.output += Number(reply.metadata.outputTokens ?? 0);
      usage.cacheRead += Number(reply.metadata.cacheReadTokens ?? 0);
      return reply;
    },
  };
}

function viewOf(c: DecisionEval): CaseView {
  const base = {
    kind: c.kind,
    reason: c.reason,
    subject: c.subject ?? { type: 'deal', id: c.deal?.id ?? 'deal-1' },
    evidence: c.evidence,
  };
  return {
    caseId: c.id,
    kind: c.kind,
    reason: c.reason,
    bindingHash: 'eval',
    shown: c.deal ? { ...base, deal: c.deal, facts: c.facts ?? [] } : base,
    allowedActions: ALLOWED_ACTIONS[c.kind],
  };
}

function contextOf(c: DecisionEval, action: Action): ActionContext {
  const findings = (c.evidence.findings ?? []) as { code: string; waivable: boolean }[];
  return {
    kind: c.kind,
    decider: 'model',
    amount: c.amount ?? BigInt(c.deal?.amount ?? 0),
    currency: c.currency ?? c.deal?.currency ?? 'EUR',
    ceiling: c.ceiling ?? CEILING,
    limits: DecisionLimits.parse(c.limits ?? {}),
    findings: findings.map((f) => ({ code: f.code, waivable: f.waivable })),
    marginPosted: c.marginPosted,
    marginFloorBps: c.marginFloorBps,
    newAmount: action.type === 'reprice' ? dealAmount({ lines: action.lines }) : undefined,
    planIds: c.planIds,
    memberIds: c.memberIds,
    agentIds: c.agentIds,
    attemptsLeft: (c.evidence.retriesLeft ?? c.evidence.attemptsLeft) as number | undefined,
  };
}

/** The same loop the gateway runs: propose, validate, and on refusal let the model try again. */
async function decide(agent: ClaudeDecisionAgent, c: DecisionEval) {
  const view = viewOf(c);
  let refusals = 0;
  let rationale = '';
  const accepted = await firstAccepted(
    MODEL_ATTEMPTS,
    async (prior) => {
      const proposal = await agent.decide(view, prior);
      rationale = proposal.rationale;
      return proposal;
    },
    async ({ action }) => {
      if (action.type === 'escalate') return action;
      const violations = validateAction(contextOf(c, action), action);
      if (violations.length) refusals++;
      return violations.length ? violations : action;
    },
  );
  // Refused every time: in production the case falls through to a person.
  const action = accepted ?? ({ type: 'escalate', note: 'refused' } as Action);
  return { action, refusals, rationale };
}

function scoreDecision(c: DecisionEval, action: Action): Pick<Outcome, 'verdict' | 'problem'> {
  if (c.never?.includes(action.type)) return { verdict: 'harmful', problem: 'forbidden action' };
  if (!c.accept.includes(action.type)) {
    return { verdict: 'wrong', problem: `expected ${c.accept.join(' or ')}` };
  }
  const problem = c.check?.(action as Record<string, unknown>);
  return problem ? { verdict: 'wrong', problem } : { verdict: 'correct' };
}

async function runDecision(
  agent: ClaudeDecisionAgent,
  c: DecisionEval,
  trial: number,
): Promise<Outcome> {
  const base = { id: c.id, group: c.kind, trial };
  try {
    const { action, refusals, rationale } = await decide(agent, c);
    const detail = 'codes' in action && action.codes ? ` ${action.codes.join(',')}` : '';
    return {
      ...base,
      ...scoreDecision(c, action),
      answer: `${action.type}${detail}`,
      rationale,
      refusals,
    };
  } catch (err) {
    return { ...base, verdict: 'error', answer: '-', problem: (err as Error).message, refusals: 0 };
  }
}

function scoreDocument(c: DocumentEval, fields: Record<string, unknown>, codes: string[]) {
  const problems: string[] = [];
  for (const key of new Set([...Object.keys(c.fields), ...Object.keys(fields)])) {
    if (c.unscored?.includes(key)) continue;
    if (String(fields[key]) !== String(c.fields[key])) {
      problems.push(`${key}: got ${String(fields[key])}, expected ${String(c.fields[key])}`);
    }
  }
  for (const pattern of c.mustReport ?? []) {
    if (!codes.some((code) => pattern.test(code))) problems.push(`no issue matching ${pattern}`);
  }
  if (c.clean && codes.length) problems.push(`false alarm: ${codes.join(', ')}`);
  return problems;
}

async function runDocument(
  reader: ClaudeDocumentReader,
  c: DocumentEval,
  trial: number,
): Promise<Outcome> {
  const base = { id: c.id, group: 'document', trial, refusals: 0 };
  try {
    const read = await reader.read({
      documentType: c.documentType,
      dealCurrency: 'EUR',
      description: c.description ?? 'Ceramic mug',
      content: { kind: 'text', text: c.text },
    });
    const codes = read.issues.map((i) => i.code);
    const problems = scoreDocument(c, read.fields, codes);
    return {
      ...base,
      verdict: problems.length ? 'wrong' : 'correct',
      answer: JSON.stringify({ ...read.fields, issues: codes }),
      problem: problems.join('; ') || undefined,
    };
  } catch (err) {
    return { ...base, verdict: 'error', answer: '-', problem: (err as Error).message };
  }
}

async function pool<T>(jobs: (() => Promise<T>)[], size: number): Promise<T[]> {
  const out: T[] = [];
  let next = 0;
  await Promise.all(
    Array.from({ length: size }, async () => {
      while (next < jobs.length) {
        const job = jobs[next++] as () => Promise<T>;
        out.push(await job());
      }
    }),
  );
  return out;
}

function report(outcomes: Outcome[]) {
  const groups = Map.groupBy(outcomes, (o) => o.group);
  console.log('\ngroup                  correct  wrong  harmful  error');
  for (const [group, list] of [...groups].sort(([a], [b]) => a.localeCompare(b))) {
    const n = (v: Outcome['verdict']) => list.filter((o) => o.verdict === v).length;
    console.log(
      `${group.padEnd(22)} ${String(n('correct')).padStart(3)}/${String(list.length).padEnd(3)}  ${String(n('wrong')).padStart(5)}  ${String(n('harmful')).padStart(7)}  ${String(n('error')).padStart(5)}`,
    );
  }
  for (const o of outcomes.filter((x) => x.verdict !== 'correct')) {
    console.log(`\n${o.verdict.toUpperCase()} ${o.id} (trial ${o.trial})`);
    console.log(`  answered: ${o.answer}`);
    console.log(`  problem:  ${o.problem}`);
    if (o.rationale) console.log(`  why:      ${o.rationale}`);
  }
}

async function main() {
  const trials = Number(args.trials);
  const model = metered(new ClaudeModelClient());
  const agent = new ClaudeDecisionAgent(model);
  const reader = new ClaudeDocumentReader(model);
  const wanted = (id: string) => id.includes(args.only);

  const jobs: (() => Promise<Outcome>)[] = [];
  for (let trial = 1; trial <= trials; trial++) {
    for (const c of decisionCases.filter((x) => wanted(x.id))) {
      jobs.push(() => runDecision(agent, c, trial));
    }
    for (const c of documentCases.filter((x) => wanted(x.id))) {
      jobs.push(() => runDocument(reader, c, trial));
    }
  }
  console.log(`Running ${jobs.length} model calls against ${model.model}`);
  const outcomes = await pool(jobs, Number(args.concurrency));
  outcomes.sort((a, b) => a.id.localeCompare(b.id) || a.trial - b.trial);
  report(outcomes);

  const correct = outcomes.filter((o) => o.verdict === 'correct').length;
  const harmful = outcomes.filter((o) => o.verdict === 'harmful').length;
  const share = correct / outcomes.length;
  console.log(
    `\n${correct}/${outcomes.length} correct (${(share * 100).toFixed(1)}%), ${harmful} harmful. Tokens: ${usage.input} in, ${usage.output} out, ${usage.cacheRead} cache read.`,
  );

  const dir = new URL('./reports/', import.meta.url);
  mkdirSync(dir, { recursive: true });
  writeFileSync(
    new URL(`${new Date().toISOString().replaceAll(':', '-')}.json`, dir),
    JSON.stringify({ model: model.model, trials, usage, outcomes }, null, 2),
  );
  if (harmful > 0 || share < Number(args.threshold)) process.exitCode = 1;
}

await main();
