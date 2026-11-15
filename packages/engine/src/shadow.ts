import { DBOS } from '@dbos-inc/dbos-sdk';
import { DomainError, parseInput } from '@novate/core';
import { decisionCases, decisionOutcomes, shadowResults, shadowRuns } from '@novate/db';
import {
  ALLOWED_ACTIONS,
  type CaseKind,
  CaseKind as CaseKindSchema,
  type CaseView,
  type DecisionAgent,
  Decisions,
  firstAccepted,
  type Proposal,
  validateAction,
} from '@novate/policy';
import { and, count, desc, eq, gte, inArray, lt, sql } from 'drizzle-orm';
import { z } from 'zod';
import { actionContext } from './decisions.ts';
import { deps, isWorkflowControl, tx } from './deps.ts';

export const ShadowCandidate = z
  .object({
    model: z
      .string()
      .regex(/^claude-[a-z0-9-]+$/)
      .optional(),
    effort: z.enum(['low', 'medium', 'high', 'xhigh', 'max']).optional(),
    /** Added to the risk agent's instructions, for this replay only. */
    instructions: z.string().min(1).max(4_000).optional(),
    /** Different limits to test. Without a model change the recorded decisions are re-checked. */
    decisions: Decisions.optional(),
  })
  .refine((c) => Object.values(c).some((v) => v !== undefined), {
    message: 'Change at least one thing to compare',
  });
export type ShadowCandidate = z.infer<typeof ShadowCandidate>;

export const StartShadowRun = z.object({
  candidate: ShadowCandidate,
  kinds: z.array(CaseKindSchema).min(1).optional(),
  /** A replay with a model costs money per case, so it has a hard limit. */
  limit: z.int().min(1).max(200).default(50),
});

const DAY_MS = 86_400_000;
const MAX_RUNS_PER_DAY = 10;
const STRANDED_AFTER_MS = 60_000;

type CaseRow = typeof decisionCases.$inferSelect;
interface Replayable {
  c: CaseRow;
  verdict: 'good' | 'bad' | 'neutral' | null;
}
type Answer = { action: string; rationale?: string; violations: string[] };

const usesModel = (c: ShadowCandidate) => Boolean(c.model || c.effort || c.instructions);
const recordedAction = (c: CaseRow) => (c.resolution as { action: Proposal['action'] }).action;

const viewOf = (c: CaseRow): CaseView => ({
  caseId: c.id,
  kind: c.kind as CaseKind,
  reason: c.reason,
  bindingHash: c.bindingHash,
  shown: c.shown,
  allowedActions: ALLOWED_ACTIONS[c.kind as CaseKind],
});

/** One case, through the same propose, check and retry loop as production. Nothing is applied. */
async function replay(
  { c }: Replayable,
  candidate: ShadowCandidate,
  agent: DecisionAgent | undefined,
): Promise<Answer> {
  const decider = { type: 'model' as const, id: 'shadow' };
  let violations: string[] = [];
  const attempts = agent ? (candidate.decisions?.modelAttempts ?? 2) : 1;
  const accepted = await firstAccepted(
    attempts,
    (prior) =>
      agent
        ? DBOS.runStep(() => agent.decide(viewOf(c), prior), {
            name: 'shadow_model',
            retriesAllowed: true,
            maxAttempts: 3,
          })
        : Promise.resolve({ action: recordedAction(c), rationale: 'recorded decision' }),
    async (proposal) => {
      violations = validateAction(
        actionContext(c, decider, proposal.action, candidate.decisions),
        proposal.action,
      );
      return violations.length ? violations : proposal;
    },
  );
  return accepted
    ? { action: accepted.action.type, rationale: accepted.rationale, violations: [] }
    : { action: 'to_person', violations };
}

interface ShadowSummary {
  replayed: number;
  same: number;
  changed: number;
  toPerson: number;
  /** The original went badly and the candidate would have done something else. */
  wouldHaveFixed: number;
  /** The original went well and the candidate would have done something else. */
  wouldHaveChanged: number;
}

async function runShadow(
  tenantId: string,
  runId: string,
  candidate: ShadowCandidate,
  kinds: string[] | undefined,
  limit: number,
): Promise<void> {
  const summary: ShadowSummary = {
    replayed: 0,
    same: 0,
    changed: 0,
    toPerson: 0,
    wouldHaveFixed: 0,
    wouldHaveChanged: 0,
  };
  try {
    const agent = usesModel(candidate) ? deps().candidateAgent?.(candidate) : undefined;
    const cases = await tx('shadow_cases', (db) =>
      db
        .select({ c: decisionCases, verdict: decisionOutcomes.verdict })
        .from(decisionCases)
        .leftJoin(decisionOutcomes, eq(decisionOutcomes.caseId, decisionCases.id))
        .where(
          and(
            eq(decisionCases.tenantId, tenantId),
            eq(decisionCases.status, 'decided'),
            sql`${decisionCases.resolution}->'decider'->>'type' = 'model'`,
            kinds ? inArray(decisionCases.kind, kinds) : undefined,
          ),
        )
        .orderBy(desc(decisionCases.createdAt))
        .limit(limit),
    );
    for (const item of cases) {
      const answer = await replay(item, candidate, agent).catch((err: Error): Answer => {
        if (isWorkflowControl(err)) throw err;
        return { action: 'error', rationale: err.message.slice(0, 500), violations: [] };
      });
      const recorded = recordedAction(item.c).type;
      const changed = answer.action !== recorded;
      summary.replayed++;
      if (!changed) summary.same++;
      else summary.changed++;
      if (answer.action === 'to_person') summary.toPerson++;
      if (changed && item.verdict === 'bad') summary.wouldHaveFixed++;
      if (changed && item.verdict === 'good') summary.wouldHaveChanged++;
      await tx('shadow_result', (db) =>
        db
          .insert(shadowResults)
          .values({
            runId,
            caseId: item.c.id,
            recorded,
            candidate: answer.action,
            rationale: answer.rationale,
            verdict: item.verdict,
            violations: answer.violations,
          })
          .onConflictDoNothing(),
      );
    }
    await finish(runId, 'done', summary);
  } catch (err) {
    if (isWorkflowControl(err)) throw err;
    console.error(`Shadow run ${runId} failed:`, err);
    await finish(runId, 'failed', summary);
  }
}

const finish = (runId: string, status: 'done' | 'failed', summary: ShadowSummary) =>
  tx('shadow_finish', (db) =>
    db
      .update(shadowRuns)
      .set({ status, summary: { ...summary }, finishedAt: new Date() })
      .where(eq(shadowRuns.id, runId)),
  );

const shadowWorkflow = DBOS.registerWorkflow(runShadow, { name: 'shadowRun' });

/** Compare a candidate with past decisions. One at a time per tenant, because each costs money. */
export async function startShadowRun(
  tenantId: string,
  input: z.input<typeof StartShadowRun>,
): Promise<{ id: string }> {
  const { candidate, kinds, limit } = parseInput(StartShadowRun, input);
  if (usesModel(candidate) && !deps().candidateAgent) {
    throw new DomainError('invalid', 'No model is configured to replay with');
  }
  const run = await tx('shadow_start', async (db) => {
    const since = new Date(Date.now() - DAY_MS);
    const [today] = await db
      .select({ n: count() })
      .from(shadowRuns)
      .where(and(eq(shadowRuns.tenantId, tenantId), gte(shadowRuns.createdAt, since)));
    if ((today?.n ?? 0) >= MAX_RUNS_PER_DAY) {
      throw new DomainError('conflict', 'Too many replays today');
    }
    // The unique index is what makes this one at a time, even for two requests at once.
    const [created] = await db
      .insert(shadowRuns)
      .values({ tenantId, candidate: { ...candidate } })
      .onConflictDoNothing()
      .returning({ id: shadowRuns.id });
    if (!created) throw new DomainError('conflict', 'A replay is already running');
    return created;
  });
  await DBOS.startWorkflow(shadowWorkflow, { workflowID: run.id })(
    tenantId,
    run.id,
    candidate,
    kinds,
    limit,
  );
  return run;
}

export async function shadowRunDetail(tenantId: string, runId: string) {
  const { db } = deps();
  const [run] = await db
    .select()
    .from(shadowRuns)
    .where(and(eq(shadowRuns.id, runId), eq(shadowRuns.tenantId, tenantId)));
  if (!run) throw new DomainError('not_found', 'Replay not found');
  const results = await db.select().from(shadowResults).where(eq(shadowResults.runId, runId));
  return { run, results };
}

/** A run saved just before a crash has no workflow, and would block every later run. */
export async function reapStrandedShadowRuns(tenantId: string): Promise<void> {
  const running = await tx('shadow_running', (db) =>
    db
      .select({ id: shadowRuns.id })
      .from(shadowRuns)
      .where(
        and(
          eq(shadowRuns.tenantId, tenantId),
          eq(shadowRuns.status, 'running'),
          lt(shadowRuns.createdAt, new Date(Date.now() - STRANDED_AFTER_MS)),
        ),
      ),
  );
  for (const { id } of running) {
    const status = await DBOS.getWorkflowStatus(id);
    if (!status) {
      await finish(id, 'failed', {
        replayed: 0,
        same: 0,
        changed: 0,
        toPerson: 0,
        wouldHaveFixed: 0,
        wouldHaveChanged: 0,
      });
    }
  }
}
