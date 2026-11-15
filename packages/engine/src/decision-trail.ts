import { DomainError, sha256 } from '@novate/core';
import {
  dealEvents,
  decisionCases,
  decisionOutcomes,
  decisionRecords,
  ledgerTransfers,
} from '@novate/db';
import { and, asc, desc, eq, gte } from 'drizzle-orm';
import { deps } from './deps.ts';

const FEED_SIZE = 100;
const EFFECTS = 50;

/** Recent decisions of every kind, whoever made them, with how each turned out. */
export async function decisionFeed(tenantId: string) {
  const rows = await deps()
    .db.select({
      id: decisionCases.id,
      dealId: decisionCases.dealId,
      kind: decisionCases.kind,
      reason: decisionCases.reason,
      status: decisionCases.status,
      resolution: decisionCases.resolution,
      createdAt: decisionCases.createdAt,
      verdict: decisionOutcomes.verdict,
    })
    .from(decisionCases)
    .leftJoin(decisionOutcomes, eq(decisionOutcomes.caseId, decisionCases.id))
    .where(eq(decisionCases.tenantId, tenantId))
    .orderBy(desc(decisionCases.createdAt))
    .limit(FEED_SIZE);
  return rows;
}

/**
 * The full story of one decision: what was shown, each proposal and refusal, what happened to the
 * deal and the money, and whether the record still matches the hash taken when it was shown.
 */
export async function decisionTrail(tenantId: string, caseId: string) {
  const { db } = deps();
  const [row] = await db
    .select()
    .from(decisionCases)
    .where(and(eq(decisionCases.id, caseId), eq(decisionCases.tenantId, tenantId)));
  if (!row) throw new DomainError('not_found', 'Case not found');
  const subject = row.dealId ?? row.subjectId;
  const [steps, outcome, money, events] = await Promise.all([
    db
      .select()
      .from(decisionRecords)
      .where(eq(decisionRecords.caseId, caseId))
      .orderBy(asc(decisionRecords.createdAt)),
    db.select().from(decisionOutcomes).where(eq(decisionOutcomes.caseId, caseId)),
    db
      .select({
        kind: ledgerTransfers.kind,
        amount: ledgerTransfers.amount,
        currency: ledgerTransfers.currency,
        at: ledgerTransfers.createdAt,
      })
      .from(ledgerTransfers)
      .where(
        and(
          eq(ledgerTransfers.tenantId, tenantId),
          eq(ledgerTransfers.ref, subject),
          gte(ledgerTransfers.createdAt, row.createdAt),
        ),
      )
      .orderBy(asc(ledgerTransfers.createdAt))
      .limit(EFFECTS),
    row.dealId
      ? db
          .select({ type: dealEvents.type, payload: dealEvents.payload, at: dealEvents.createdAt })
          .from(dealEvents)
          .where(and(eq(dealEvents.dealId, row.dealId), gte(dealEvents.createdAt, row.createdAt)))
          .orderBy(asc(dealEvents.seq))
          .limit(EFFECTS)
      : Promise.resolve([]),
  ]);
  return {
    case: {
      id: row.id,
      kind: row.kind,
      reason: row.reason,
      status: row.status,
      createdAt: row.createdAt,
      closedAt: row.closedAt,
      shown: row.shown,
    },
    untampered: sha256(row.shown) === row.bindingHash,
    steps: steps.map((s) => ({
      decider: s.deciderType,
      deciderId: s.deciderId,
      action: s.action,
      rationale: s.rationale,
      accepted: s.accepted === 1,
      refusedBecause: s.violations,
      at: s.createdAt,
    })),
    outcome: outcome[0] ?? null,
    events,
    money,
  };
}
