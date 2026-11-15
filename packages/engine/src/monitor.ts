import { DBOS } from '@dbos-inc/dbos-sdk';
import { mulDivUp } from '@novate/core';
import { agents, deals, decisionCases, members, type Tx } from '@novate/db';
import { Accounts } from '@novate/ledger';
import { type Decisions, durationMs } from '@novate/policy';
import { and, desc, eq, gte, inArray, isNotNull, isNull, lt, or } from 'drizzle-orm';
import { resolveStuckCardPayments } from './card-funding.ts';
import { resolveForDeal, signalSubject } from './deal-policy.ts';
import { dealWorkflow, type SettlementMessage } from './deal-workflow.ts';
import { dealCase, resolveCase } from './decisions.ts';
import { deps, isWorkflowControl, tryPost, tx } from './deps.ts';
import { type PortfolioSummary, reviewPortfolioMargin } from './portfolio-margin.ts';
import {
  type AgentRow,
  type DealRow,
  getDeal,
  loadProgramSpec,
  type PolicySnapshot,
  record,
  snapshotOf,
} from './repo.ts';
import { reapStrandedShadowRuns } from './shadow.ts';
import { Topics } from './topics.ts';
import { judgeMaturedDecisions } from './track-record.ts';

const DAY = 86_400_000;
const RECORD_DEALS = 20;
const STRANDED_AFTER_MS = 60_000;
const OPEN = ['awaiting_conditions', 'held', 'eligible'] as const;

export interface MonitorSummary {
  marginReviews: number;
  marginResized: number;
  marginCalls: number;
  agentsReviewed: number;
  agentsSuspended: number;
  agentsReinstated: number;
  dealsRefunded: number;
  decisionsJudged: number;
  portfolio: PortfolioSummary;
}

/**
 * Watch open positions after deal time. Code works out what the numbers now imply, a decider
 * chooses what to do about it, and code carries that out within the program's limits.
 */
async function monitorTenant(tenantId: string): Promise<MonitorSummary> {
  const summary: MonitorSummary = {
    marginReviews: 0,
    marginResized: 0,
    marginCalls: 0,
    agentsReviewed: 0,
    agentsSuspended: 0,
    agentsReinstated: 0,
    dealsRefunded: 0,
    decisionsJudged: 0,
    portfolio: { assessed: 0, calls: 0, extended: 0, defaults: 0 },
  };
  const open = await tx('monitor_open', (db) =>
    db
      .select()
      .from(deals)
      .where(
        and(
          eq(deals.tenantId, tenantId),
          inArray(deals.status, [...OPEN]),
          isNotNull(deals.marginCurrency),
        ),
      ),
  );
  for (const deal of open) {
    // One bad deal must not stop every later deal and agent from being looked at.
    try {
      await reviewMargin(deal, summary);
    } catch (err) {
      if (isWorkflowControl(err)) throw err;
      console.error(`Margin review of deal ${deal.id} failed:`, err);
    }
  }
  await restartStrandedDeals(tenantId);
  await reapStrandedShadowRuns(tenantId);
  summary.decisionsJudged = await tx('monitor_judge', (db) => judgeMaturedDecisions(db, tenantId));
  await resolveStuckCardPayments(tenantId, new Date(await DBOS.now()));

  // Collateral is reviewed apart, so a failure here cannot stop deals and agents being looked at.
  try {
    summary.portfolio = await reviewPortfolioMargin(tenantId);
  } catch (err) {
    if (isWorkflowControl(err)) throw err;
    console.error(`Portfolio margin review of tenant ${tenantId} failed:`, err);
  }

  const uncured = await tx('monitor_uncured', (db) => dealsPastCure(db, tenantId));
  for (const { dealId, sellerAtFault } of uncured) {
    const message: SettlementMessage = { type: 'cure_expired', sellerAtFault };
    await DBOS.send(dealId, message, Topics.settled, `cure:${dealId}`);
  }
  summary.dealsRefunded = uncured.length;

  const toReview = await tx('monitor_agents', (db) => agentsToReview(db, tenantId));
  for (const review of toReview) await reviewAgent(tenantId, review, summary);
  return summary;
}

export const monitorWorkflow = DBOS.registerWorkflow(monitorTenant, { name: 'monitorTenant' });

/**
 * A deal is saved and then its workflow is started. A crash in between leaves it saved with nothing
 * running, and nobody can be relied on to resubmit. Starting a workflow that exists does nothing.
 */
async function restartStrandedDeals(tenantId: string) {
  const stranded = await tx('monitor_stranded', (db) =>
    db
      .select({ id: deals.id })
      .from(deals)
      .where(
        and(
          eq(deals.tenantId, tenantId),
          eq(deals.status, 'submitted'),
          isNull(deals.awaitingSide),
          lt(deals.createdAt, new Date(Date.now() - STRANDED_AFTER_MS)),
        ),
      ),
  );
  for (const { id } of stranded) {
    await DBOS.startWorkflow(dealWorkflow, { workflowID: id })(id);
  }
}

async function reviewedRecently(db: Tx, subjectId: string, kind: string): Promise<boolean> {
  const [row] = await db
    .select({ id: decisionCases.id })
    .from(decisionCases)
    .where(
      and(
        eq(decisionCases.subjectId, subjectId),
        eq(decisionCases.kind, kind),
        gte(decisionCases.createdAt, new Date(Date.now() - DAY)),
      ),
    )
    .limit(1);
  return Boolean(row);
}

/** Deals held back by a suspended member, past the time the program gives them to come good. */
async function dealsPastCure(db: Tx, tenantId: string) {
  const inactive = new Set(
    (
      await db
        .select({ id: members.id })
        .from(members)
        .where(and(eq(members.tenantId, tenantId), eq(members.status, 'suspended')))
    ).map((m) => m.id),
  );
  if (!inactive.size) return [];
  const waiting = await db
    .select()
    .from(deals)
    .where(and(eq(deals.tenantId, tenantId), eq(deals.status, 'eligible')));
  return waiting.flatMap((d) => {
    if (!inactive.has(d.buyerMemberId) && !inactive.has(d.sellerMemberId)) return [];
    const cure = durationMs(snapshotOf(d).resolved.policy.settlement.cureWindow);
    if (Date.now() - d.updatedAt.getTime() < cure) return [];
    return [{ dealId: d.id, sellerAtFault: inactive.has(d.sellerMemberId) }];
  });
}

// ── Margin ─────────────────────────────────────────────────────────────────

async function reviewMargin(deal: DealRow, summary: MonitorSummary) {
  const snapshot = snapshotOf(deal);
  const { decisions, margin } = snapshot.resolved.policy;
  if (margin.mode !== 'scored') return;
  const signals = await DBOS.runStep(
    () => deps().signals.resolve(Object.keys(snapshot.signals), signalSubject(deal)),
    { name: 'monitor_signals' },
  );
  const review = await tx('monitor_margin', (db) => marginTarget(db, deal, signals));
  if (!review) return;
  summary.marginReviews++;

  const reason = `Seller risk now implies ${review.targetBps}bps margin, ${review.currentBps}bps is posted`;
  const res = await resolveCase(
    dealCase(deal, decisions, 'margin_review', reason, review, {
      skipPerson: true,
      // Agents may only move a reserve the way the numbers point. A review never empties one.
      marginFloorBps: Math.min(review.targetBps, review.currentBps),
    }),
  );
  if (res.outcome !== 'decided') return;

  const { action } = res;
  let met: boolean;
  if (action.type === 'resize_margin') {
    met = await tx('monitor_resize', (db) => resizeMargin(db, deal, res.caseId, action.bps));
    if (met) summary.marginResized++;
  } else if (action.type === 'margin_call') {
    met = await tx('monitor_call', (db) =>
      topUpMargin(db, deal, res.caseId, BigInt(action.amount)),
    );
  } else {
    return;
  }
  if (met) return;
  summary.marginCalls++;
  if (deal.sellerAgentId) {
    const trigger = 'Seller could not meet a margin call';
    await reviewAgent(
      deal.tenantId,
      { agentId: deal.sellerAgentId, deal, decisions, trigger },
      summary,
    );
  }
}

async function marginTarget(db: Tx, deal: DealRow, signals: PolicySnapshot['signals']) {
  if (await reviewedRecently(db, deal.id, 'margin_review')) return null;
  const fresh = await resolveForDeal(db, deal, await loadProgramSpec(db, deal), signals);
  const currentBps = snapshotOf(deal).resolved.marginBps;
  if (fresh.marginBps === currentBps) return null;
  // Evidence is in question, so this is the moment the reserve matters most.
  if (fresh.marginBps < currentBps && deal.status === 'held') return null;
  return { currentBps, targetBps: fresh.marginBps, trace: fresh.marginTrace };
}

const stillOpen = async (db: Tx, deal: DealRow) =>
  (OPEN as readonly string[]).includes((await getDeal(db, deal.id)).status);

/** Move the seller's wallet into margin. False means it cannot pay: a margin call failed. */
async function topUpMargin(db: Tx, deal: DealRow, caseId: string, extra: bigint): Promise<boolean> {
  // A slow decision can outlast the deal, and margin on a closed deal would never come back.
  if (extra === 0n || !(await stillOpen(db, deal))) return true;
  const currency = deal.marginCurrency as string;
  const margin = Accounts.dealMargin(deal.id, currency);
  const paid = await tryPost(db, deal.tenantId, [
    {
      key: `deal:${deal.id}:margin:topup:${caseId}`,
      debit: Accounts.memberAvailable(deal.sellerMemberId, currency),
      credit: margin,
      amount: extra,
      kind: 'margin_topup',
      ref: deal.id,
    },
  ]);
  if (!paid) await record(db, deal.id, 'margin_call_failed', { extra });
  return paid;
}

async function resizeMargin(db: Tx, deal: DealRow, caseId: string, bps: number): Promise<boolean> {
  const snapshot = snapshotOf(deal);
  const currentBps = snapshot.resolved.marginBps;
  if (bps === currentBps || currentBps === 0) return true;
  const currency = deal.marginCurrency as string;
  const account = Accounts.dealMargin(deal.id, currency);
  const posted = await deps().ledger.balance(db, deal.tenantId, account);
  const target = mulDivUp(posted, BigInt(bps), BigInt(currentBps));
  if (bps > currentBps) {
    if (!(await topUpMargin(db, deal, caseId, target - posted))) return false;
  } else if (posted > target) {
    // Read now: a decision can take long enough for the deal to have been held or closed.
    const { status } = await getDeal(db, deal.id);
    if (status === 'held' || !(OPEN as readonly string[]).includes(status)) return true;
    await deps().ledger.post(db, deal.tenantId, [
      {
        key: `deal:${deal.id}:margin:release:${caseId}`,
        debit: account,
        credit: Accounts.memberAvailable(deal.sellerMemberId, currency),
        amount: posted - target,
        kind: 'margin_release',
        ref: deal.id,
      },
    ]);
  }
  const next = { ...snapshot, resolved: { ...snapshot.resolved, marginBps: bps } };
  await db
    .update(deals)
    .set({ policySnapshot: next as unknown as Record<string, unknown> })
    .where(eq(deals.id, deal.id));
  await record(db, deal.id, 'margin_resized', { from: currentBps, to: bps, posted, target });
  return true;
}

// ── Agents ─────────────────────────────────────────────────────────────────

interface AgentReview {
  agentId: string;
  deal: DealRow;
  decisions: Decisions;
  trigger: string;
}

async function latestDealOf(db: Tx, agent: AgentRow): Promise<DealRow | undefined> {
  const [deal] = await db
    .select()
    .from(deals)
    .where(or(eq(deals.buyerAgentId, agent.id), eq(deals.sellerAgentId, agent.id)))
    .orderBy(desc(deals.createdAt))
    .limit(1);
  return deal;
}

async function agentsToReview(db: Tx, tenantId: string): Promise<AgentReview[]> {
  const out: AgentReview[] = [];
  const rejected = await db
    .select()
    .from(deals)
    .where(
      and(
        eq(deals.tenantId, tenantId),
        eq(deals.status, 'rejected'),
        gte(deals.createdAt, new Date(Date.now() - DAY)),
      ),
    );
  const byAgent = Map.groupBy(
    rejected.filter((d) => d.buyerAgentId),
    (d) => d.buyerAgentId as string,
  );
  for (const [agentId, list] of byAgent) {
    const deal = list[0] as DealRow;
    const spec = await loadProgramSpec(db, deal);
    if (list.length < spec.monitor.agentRejectionsPerDay) continue;
    if (await reviewedRecently(db, agentId, 'agent_review')) continue;
    const trigger = `${list.length} deals rejected in a day`;
    out.push({ agentId, deal, decisions: spec.decisions, trigger });
  }

  // A suspended agent gets another look each day, so suspension is never silently permanent.
  const blocked = await db
    .select()
    .from(agents)
    .where(and(eq(agents.tenantId, tenantId), eq(agents.status, 'blocked')));
  for (const agent of blocked) {
    if (await reviewedRecently(db, agent.id, 'agent_review')) continue;
    const deal = await latestDealOf(db, agent);
    if (!deal) continue;
    const { decisions } = await loadProgramSpec(db, deal);
    const trigger = 'Periodic review of a suspended agent';
    out.push({ agentId: agent.id, deal, decisions, trigger });
  }
  return out;
}

/** What a reviewer needs to tell a malfunction from a run of bad luck. */
async function agentRecord(db: Tx, agentId: string) {
  const [agent] = await db.select().from(agents).where(eq(agents.id, agentId));
  const recent = await db
    .select({
      status: deals.status,
      reason: deals.statusReason,
      amount: deals.amount,
      currency: deals.currency,
      createdAt: deals.createdAt,
    })
    .from(deals)
    .where(or(eq(deals.buyerAgentId, agentId), eq(deals.sellerAgentId, agentId)))
    .orderBy(desc(deals.createdAt))
    .limit(RECORD_DEALS);
  return { name: agent?.name, status: agent?.status, mandate: agent?.mandate, recentDeals: recent };
}

async function reviewAgent(tenantId: string, review: AgentReview, summary: MonitorSummary) {
  const { agentId, deal, decisions, trigger } = review;
  summary.agentsReviewed++;
  const record = await tx('agent_record', (db) => agentRecord(db, agentId));
  const res = await resolveCase({
    tenantId,
    kind: 'agent_review',
    subjectType: 'agent',
    subjectId: agentId,
    reason: trigger,
    evidence: { agentId, trigger, record },
    amount: 0n,
    currency: deal.currency,
    decisions,
    agentIds: [agentId],
    skipPerson: true,
  });
  if (res.outcome !== 'decided') return;
  if (res.action.type !== 'suspend_agent' && res.action.type !== 'reinstate_agent') return;
  const status = res.action.type === 'suspend_agent' ? 'blocked' : 'active';
  await tx('set_agent_status', (db) =>
    db
      .update(agents)
      .set({ status })
      .where(and(eq(agents.id, agentId), eq(agents.tenantId, tenantId))),
  );
  if (status === 'blocked') summary.agentsSuspended++;
  else summary.agentsReinstated++;
}
