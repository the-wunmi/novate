import { DBOS } from '@dbos-inc/dbos-sdk';
import {
  CLAIM_EVIDENCE,
  DealTerms,
  DomainError,
  dealAmount,
  dealQuantity,
  describePrincipal,
  MinorAmount,
  mayAssertFact,
  mayFileDocument,
  type Principal,
  parseInput,
  readsAsStaff,
  sha256,
  sideOf,
  TERMINAL_DEAL_STATUSES,
} from '@novate/core';
import {
  agents,
  cycles,
  dealEvents,
  dealFacts,
  deals,
  decisionCases,
  decisionRecords,
  members,
  obligations,
  type Tx,
  x402Payments,
} from '@novate/db';
import {
  type Claimant,
  ProgramSpec,
  releaseWaitsFor,
  shipmentTolerance,
  validateFactData,
} from '@novate/policy';
import { and, asc, count, desc, eq, exists, ilike, inArray, isNotNull, or, sql } from 'drizzle-orm';
import { alias } from 'drizzle-orm/pg-core';
import { z } from 'zod';
import { claimStanding, claimWorkflow, heldBack, paidOn } from './claims.ts';
import { actorOf, recordControl } from './control.ts';
import { shapeProblem } from './deal-policy.ts';
import { dealWorkflow } from './deal-workflow.ts';
import { type CaseMessage, caseView } from './decisions.ts';
import { deps, tx } from './deps.ts';
import { Cursor, pageOf } from './page.ts';
import { partyClaims, partyHistory } from './portal.ts';
import { latestProgram } from './programs.ts';
import {
  agentInTenant,
  type DealRow,
  dealInTenant,
  inTenant,
  memberInTenant,
  record,
  snapshotOf,
  withTerms,
} from './repo.ts';
import { Topics } from './topics.ts';

export const SubmitDeal = z
  .object({
    idempotencyKey: z.string().min(1),
    programKey: z.string(),
    buyerMemberId: z.string().uuid(),
    sellerMemberId: z.string().uuid(),
    buyerAgentId: z.string().uuid().optional(),
    sellerAgentId: z.string().uuid().optional(),
    terms: DealTerms,
  })
  .refine((d) => d.buyerMemberId !== d.sellerMemberId, { message: 'Buyer and seller must differ' });
export type SubmitDeal = z.input<typeof SubmitDeal>;

type ParsedDeal = z.output<typeof SubmitDeal>;

/** Which side of the deal a credential speaks for. `null` means it is trusted to speak for both. */
function submittingSide(p: Principal, d: ParsedDeal): 'buyer' | 'seller' | null {
  if (p.kind === 'platform' || p.kind === 'house') return null;
  if (p.kind === 'member') {
    const side = sideOf(p, d);
    if (side) return side;
  }
  if (p.kind === 'agent' && p.agentId === d.buyerAgentId) return 'buyer';
  if (p.kind === 'agent' && p.agentId === d.sellerAgentId) return 'seller';
  throw new DomainError('unauthorised_agent', 'Not allowed to submit this deal');
}

async function assertAgentActsFor(db: Tx, tenantId: string, agentId: string, memberId: string) {
  const agent = await agentInTenant(db, tenantId, agentId);
  if (agent.memberId !== memberId) throw new DomainError('not_found', 'Agent not found');
}

const otherSide = (side: 'buyer' | 'seller') => (side === 'buyer' ? 'seller' : 'buyer');

/**
 * Accept a deal and start its durable lifecycle. A party cannot bind the other side: its deal waits
 * until the other side submits the same thing under the same key. Idempotent per tenant and key.
 */
export async function submitDeal(principal: Principal, input: SubmitDeal) {
  const d = parseInput(SubmitDeal, input);
  const side = submittingSide(principal, d);
  const { tenantId } = principal;
  const program = await latestProgram(tenantId, d.programKey);
  const shape = shapeProblem(ProgramSpec.parse(program.spec), d.terms);
  if (shape) throw new DomainError('invalid', shape);
  const termsHash = sha256(d);

  const row = await tx('submit_deal', async (db) => {
    await memberInTenant(db, tenantId, d.buyerMemberId);
    await memberInTenant(db, tenantId, d.sellerMemberId);
    for (const leg of d.terms.legs) await memberInTenant(db, tenantId, leg.payeeMemberId);
    if (d.buyerAgentId) await assertAgentActsFor(db, tenantId, d.buyerAgentId, d.buyerMemberId);
    if (d.sellerAgentId) await assertAgentActsFor(db, tenantId, d.sellerAgentId, d.sellerMemberId);

    const [created] = await db
      .insert(deals)
      .values({
        tenantId,
        idempotencyKey: d.idempotencyKey,
        programId: program.id,
        buyerMemberId: d.buyerMemberId,
        sellerMemberId: d.sellerMemberId,
        buyerAgentId: d.buyerAgentId,
        sellerAgentId: d.sellerAgentId,
        currency: d.terms.currency,
        amount: dealAmount(d.terms),
        quantity: dealQuantity(d.terms),
        terms: d.terms,
        termsHash,
        awaitingSide: side ? otherSide(side) : null,
      })
      .onConflictDoNothing({ target: [deals.tenantId, deals.idempotencyKey] })
      .returning();
    if (created) {
      await record(db, created.id, 'submitted', {
        program: `${program.key}@v${program.version}`,
        awaitingSide: created.awaitingSide,
        source: describePrincipal(principal),
        ...filedBy(principal),
      });
      return created;
    }
    return confirmExisting(db, principal, d, side, termsHash);
  });
  // The deal id is the workflow id: starting twice is a no-op.
  if (!row.awaitingSide) await DBOS.startWorkflow(dealWorkflow, { workflowID: row.id })(row.id);
  return row;
}

/** The same key again: a retry, or the other side confirming. Different terms are refused. */
async function confirmExisting(
  db: Tx,
  principal: Principal,
  d: ParsedDeal,
  side: 'buyer' | 'seller' | null,
  termsHash: string,
): Promise<DealRow> {
  const { tenantId } = principal;
  const [existing] = await db
    .select()
    .from(deals)
    .where(and(eq(deals.tenantId, tenantId), eq(deals.idempotencyKey, d.idempotencyKey)))
    .for('update');
  const deal = existing as DealRow;
  if (deal.termsHash !== termsHash) {
    throw new DomainError('conflict', 'A deal with this key has different terms');
  }
  if (!deal.awaitingSide || (side && side !== deal.awaitingSide)) return deal;
  const [confirmed] = await db
    .update(deals)
    .set({ awaitingSide: null })
    .where(eq(deals.id, deal.id))
    .returning();
  await record(db, deal.id, 'confirmed', {
    side: side ?? 'operator',
    source: describePrincipal(principal),
    ...filedBy(principal),
  });
  return confirmed as DealRow;
}

export const SubmitFact = z.object({
  kind: z.string().min(1),
  type: z.string().min(1),
  data: z.record(z.string(), z.unknown()),
});

/**
 * Attach evidence to a deal and wake its workflow. The source is taken from the credential, and
 * each kind of fact can only be asserted by the party entitled to assert it.
 */
export async function submitFact(
  dealId: string,
  principal: Principal,
  input: z.input<typeof SubmitFact>,
) {
  const f = parseInput(SubmitFact, input);
  const deal = await dealInTenant(deps().db, principal.tenantId, dealId);
  if (!mayAssertFact(principal, deal, f.kind)) throw mayNot(principal, f.kind);
  return addFact(deal, principal, f);
}

const mayNot = (principal: Principal, what: string) =>
  new DomainError('unauthorised_agent', `${principal.kind} may not assert ${what}`);

function assertOpen(deal: DealRow) {
  if ((TERMINAL_DEAL_STATUSES as readonly string[]).includes(deal.status)) {
    throw new DomainError('conflict', `Deal is ${deal.status}`);
  }
}

/** Plenty for any real deal, and a stop on a party flooding a case with new evidence. */
const MAX_FACTS_PER_DEAL = 200;

/** Which agent and member filed something, so it can be named rather than shown as a key id. */
const filedBy = (p: Principal) => ({
  ...(p.agentId ? { agentId: p.agentId } : {}),
  ...(p.memberId ? { memberId: p.memberId } : {}),
});

const withFiler = (by: ReturnType<typeof filedBy>) =>
  by.agentId || by.memberId ? { filedBy: by } : {};

/** What a buyer's dispute or claim is about, so claims can be counted by cause. */
export const BUYER_CLAIMS = ['not_received', 'short', 'quality', 'late', 'other'] as const;
/** What a seller's is about: not paid while the deal is open, or paid short after settlement. */
export const SELLER_CLAIMS = ['not_paid', 'short_paid', 'other'] as const;
export const ClaimCategory = z.enum([...BUYER_CLAIMS, 'not_paid', 'short_paid']);

/**
 * A claim may ask for part of what it could get back, in minor units of the deal: a buyer up to what
 * the seller was paid, a seller up to what a partial release held back.
 */
function claimAmount(deal: DealRow, claimant: Claimant, given: unknown): bigint | undefined {
  if (given === undefined || given === null) return undefined;
  const parsed = MinorAmount.safeParse(given);
  if (!parsed.success || parsed.data <= 0n) {
    throw new DomainError(
      'invalid',
      'A claim amount must be a positive whole number of minor units',
    );
  }
  if (claimant === 'buyer' && parsed.data > paidOn(deal)) {
    throw new DomainError('invalid', 'A claim cannot ask for more than the seller was paid');
  }
  if (claimant === 'seller' && parsed.data > heldBack(deal)) {
    throw new DomainError('invalid', 'A claim cannot ask for more than was held back');
  }
  return parsed.data;
}

const openClaim = async (db: Tx, dealId: string) =>
  (
    await db
      .select({ id: decisionCases.id })
      .from(decisionCases)
      .where(
        and(
          eq(decisionCases.dealId, dealId),
          eq(decisionCases.kind, 'exception'),
          eq(decisionCases.status, 'open'),
        ),
      )
      .limit(1)
  ).length > 0;

/** Evidence for a claim on a settled deal, taken while a claim on it is open. */
const claimEvidence = (deal: DealRow, type: string) =>
  type === CLAIM_EVIDENCE && deal.status === 'settled';

async function addFact(deal: DealRow, principal: Principal, f: z.output<typeof SubmitFact>) {
  // A dispute on a settled deal is a claim, which a party may file for a while after settlement.
  // Filed by the house or the platform, it is the buyer's.
  const claim = f.kind === 'dispute' && deal.status === 'settled';
  const evidence = f.kind === 'document' && claimEvidence(deal, f.type);
  const claimant: Claimant = sideOf(principal, deal) ?? 'buyer';
  if (!claim && !evidence) assertOpen(deal);
  const invalid = validateFactData(f.kind, f.data);
  if (invalid) throw new DomainError('invalid', invalid);
  if (f.kind === 'dispute' && f.data.category !== undefined) {
    const side = sideOf(principal, deal);
    const allowed: readonly string[] =
      side === 'seller' ? SELLER_CLAIMS : side === 'buyer' ? BUYER_CLAIMS : ClaimCategory.options;
    if (!allowed.includes(String(f.data.category))) {
      throw new DomainError('invalid', `A claim's category is one of ${allowed.join(', ')}`);
    }
  }
  const requested = claim ? claimAmount(deal, claimant, f.data.amount) : undefined;
  if (requested !== undefined) f.data = { ...f.data, amount: requested.toString() };
  const source = describePrincipal(principal);
  const by = filedBy(principal);
  const { fact, openCaseId, waiting, startClaim } = await tx('add_fact', async (db) => {
    let startClaim = false;
    if (claim) {
      const [locked] = await db.select().from(deals).where(eq(deals.id, deal.id)).for('update');
      startClaim = !(await claimStanding(db, locked as DealRow, claimant, new Date())).alreadyOpen;
    }
    const [existing] = await db
      .select({ n: count() })
      .from(dealFacts)
      .where(eq(dealFacts.dealId, deal.id));
    if ((existing?.n ?? 0) >= MAX_FACTS_PER_DEAL) {
      throw new DomainError('conflict', 'This deal has reached its limit of evidence');
    }
    if (evidence && !(await openClaim(db, deal.id))) {
      throw new DomainError('conflict', 'No claim on this deal is open');
    }
    const [row] = await db
      .insert(dealFacts)
      .values({ dealId: deal.id, ...f, data: { ...f.data, ...withFiler(by) }, source })
      .returning();
    await record(db, deal.id, 'fact_added', {
      factId: row?.id,
      kind: f.kind,
      type: f.type,
      source,
      ...by,
    });
    if (startClaim) {
      await record(db, deal.id, 'claim_filed', { factId: row?.id, source, ...by });
    }
    const [open] = await db
      .select({ id: decisionCases.id, context: decisionCases.context })
      .from(decisionCases)
      .where(and(eq(decisionCases.dealId, deal.id), eq(decisionCases.status, 'open')));
    // A claim's case is waited on by its own workflow, not the deal's.
    const waiting = (open?.context as { workflowId?: string } | undefined)?.workflowId ?? deal.id;
    return {
      fact: row as typeof dealFacts.$inferSelect,
      openCaseId: open?.id,
      waiting,
      startClaim,
    };
  });
  if (startClaim) {
    const reason = typeof f.data.reason === 'string' ? f.data.reason : 'A party raised a dispute';
    await DBOS.startWorkflow(claimWorkflow, { workflowID: `claim:${fact.id}` })(
      deal.id,
      fact.id,
      reason,
      requested?.toString(),
      claimant,
    );
  }
  await DBOS.send(deal.id, { factId: fact.id }, Topics.fact, `fact:${fact.id}`);
  if (openCaseId) {
    const msg: CaseMessage = { type: 'evidence_changed', caseId: openCaseId };
    await DBOS.send(waiting, msg, Topics.case, `evidence:${fact.id}`);
  }
  return fact;
}

export const SubmitDocument = z.object({
  type: z.string().min(1),
  content: z.discriminatedUnion('kind', [
    z.object({ kind: z.literal('pdf'), base64: z.string().min(1) }),
    z.object({
      kind: z.literal('image'),
      mediaType: z.enum(['image/png', 'image/jpeg', 'image/webp']),
      base64: z.string().min(1),
    }),
    z.object({ kind: z.literal('text'), text: z.string().min(1) }),
  ]),
});

/**
 * Read a document with the model and attach what it found. If it cannot be read, the deal gets an
 * `unreadable` finding and goes to review. A failed read can never pass as a match.
 */
export async function submitDocument(
  dealId: string,
  principal: Principal,
  input: z.input<typeof SubmitDocument>,
) {
  const reader = deps().documentReader;
  if (!reader) throw new DomainError('invalid', 'Document reading is not configured');
  const doc = parseInput(SubmitDocument, input);
  const deal = await dealInTenant(deps().db, principal.tenantId, dealId);
  // Checked before the model is called, so nobody without standing can spend on it.
  if (!mayFileDocument(principal, deal, doc.type)) throw mayNot(principal, 'document');
  if (!claimEvidence(deal, doc.type)) assertOpen(deal);
  else if (!(await openClaim(deps().db, deal.id))) {
    throw new DomainError('conflict', 'No claim on this deal is open');
  }
  const terms = DealTerms.parse(deal.terms);
  const data = await reader
    .read({
      documentType: doc.type,
      dealCurrency: deal.currency,
      description: terms.lines.map((l) => l.description).join('; '),
      content: doc.content,
    })
    .catch((err: Error) => ({
      fields: {},
      issues: [{ code: 'read_failed', message: `The document could not be read: ${err.message}` }],
      extraction: {},
    }));
  return addFact(deal, principal, { kind: 'document', type: doc.type, data });
}

/**
 * Take an open case, or let it go, so two people do not work the same one. It only says who is on
 * it: anyone allowed to decide the case still can.
 */
export async function setCaseAssignee(
  tenantId: string,
  principal: Principal,
  caseId: string,
  assigned: boolean,
) {
  return tx('assign_case', async (db) => {
    const [row] = await db
      .select({ tenantId: decisionCases.tenantId, status: decisionCases.status })
      .from(decisionCases)
      .where(eq(decisionCases.id, caseId))
      .for('update');
    const { status } = inTenant(row, tenantId, 'Case');
    if (status !== 'open') throw new DomainError('conflict', `Case is ${status}`);
    const actor = actorOf(principal);
    const set = assigned
      ? { assignee: actor, assignedAt: new Date() }
      : { assignee: null, assignedAt: null };
    await db.update(decisionCases).set(set).where(eq(decisionCases.id, caseId));
    await recordControl(db, tenantId, actor, {
      type: assigned ? 'case_assigned' : 'case_unassigned',
      payload: { caseId },
    });
    return set;
  });
}

/** Cases waiting for a decider, oldest first, with the deal's parties when there is a deal. */
export async function openCases(tenantId: string) {
  const rows = await deps()
    .db.select({
      c: decisionCases,
      buyerMemberId: deals.buyerMemberId,
      sellerMemberId: deals.sellerMemberId,
    })
    .from(decisionCases)
    .leftJoin(deals, eq(deals.id, decisionCases.dealId))
    .where(and(eq(decisionCases.tenantId, tenantId), eq(decisionCases.status, 'open')))
    .orderBy(asc(decisionCases.createdAt), asc(decisionCases.id));
  return rows.map(({ c, ...parties }) => ({ ...caseView(c), ...parties }));
}

export async function caseRecords(tenantId: string, caseId: string) {
  const { db } = deps();
  const [row] = await db.select().from(decisionCases).where(eq(decisionCases.id, caseId));
  inTenant(row, tenantId, 'Case');
  return db
    .select()
    .from(decisionRecords)
    .where(eq(decisionRecords.caseId, caseId))
    .orderBy(asc(decisionRecords.createdAt));
}

/** Operators see everything. Others see the deal and its evidence, not the policy or the cases. */
export async function dealDetail(dealId: string, principal: Principal) {
  const { db } = deps();
  const deal = await dealInTenant(deps().db, principal.tenantId, dealId);
  if (principal.memberId && !sideOf(principal, deal)) {
    throw new DomainError('not_found', 'Deal not found');
  }
  const [facts, obligationRows, parties] = await Promise.all([
    db
      .select()
      .from(dealFacts)
      .where(eq(dealFacts.dealId, dealId))
      .orderBy(asc(dealFacts.createdAt)),
    db
      .select({ o: obligations, settledAt: cycles.closedAt })
      .from(obligations)
      .leftJoin(cycles, eq(cycles.id, obligations.cycleId))
      .where(eq(obligations.dealId, dealId))
      .orderBy(asc(obligations.createdAt))
      .then((rows) =>
        // When its cycle closed, for an obligation that settled in one.
        rows.map(({ o, settledAt }) => ({
          ...o,
          settledAt: o.status === 'settled' ? settledAt : null,
        })),
      ),
    db
      .select({ id: members.id, name: members.name })
      .from(members)
      .where(inArray(members.id, [deal.buyerMemberId, deal.sellerMemberId])),
  ]);
  // In trade both sides know who they are dealing with.
  const nameOf = (id: string) => parties.find((p) => p.id === id)?.name ?? null;
  const names = { buyerName: nameOf(deal.buyerMemberId), sellerName: nameOf(deal.sellerMemberId) };
  if (!readsAsStaff(principal)) {
    const { policySnapshot: _hidden, ...visible } = deal;
    // A party sees its deal's history and how its cases ended. Reviewers see only the evidence.
    if (!sideOf(principal, deal)) {
      return {
        deal: { ...withTerms(visible), ...names },
        facts,
        obligations: obligationRows,
        events: [],
        cases: [],
      };
    }
    const [history, claims] = await Promise.all([partyHistory(db, dealId), partyClaims(db, deal)]);
    return {
      deal: { ...withTerms(visible), ...names },
      facts,
      obligations: obligationRows,
      ...history,
      ...claims,
    };
  }
  const [events, cases] = await Promise.all([
    db
      .select()
      .from(dealEvents)
      .where(eq(dealEvents.dealId, dealId))
      .orderBy(asc(dealEvents.createdAt)),
    db
      .select()
      .from(decisionCases)
      .where(eq(decisionCases.dealId, dealId))
      .orderBy(asc(decisionCases.createdAt)),
  ]);
  // What release waits on, from the terms the deal was authorised under; none before that.
  const condition = deal.policySnapshot ? snapshotOf(deal).resolved.policy.release.condition : null;
  return {
    deal: { ...withTerms(deal), ...names },
    facts,
    obligations: obligationRows,
    events,
    cases: cases.map(caseView),
    waitingFor: condition ? releaseWaitsFor(condition) : null,
    shipmentTolerance: condition ? shipmentTolerance(condition) : null,
  };
}

/** Deals as a person groups them: still moving, waiting on a decision, settled, or stopped. */
export const DEAL_GROUPS = {
  open: [
    'submitted',
    'authorised',
    'frozen',
    'awaiting_funding',
    'awaiting_conditions',
    'held',
    'eligible',
    'settling',
  ],
  review: ['frozen', 'held'],
  settled: ['settled'],
  stopped: ['cancelled', 'refunded', 'rejected'],
} as const satisfies Record<string, readonly DealRow['status'][]>;
type DealGroup = keyof typeof DEAL_GROUPS;

const DEAL_SORTS = {
  newest: { by: 'createdAt', desc: true },
  oldest: { by: 'createdAt', desc: false },
  largest: { by: 'amount', desc: true },
  smallest: { by: 'amount', desc: false },
} as const;

export const ListDeals = z.object({
  /** Either side of the deal. */
  memberId: z.string().uuid().optional(),
  status: z.enum(Object.keys(DEAL_GROUPS) as [DealGroup, ...DealGroup[]]).optional(),
  /** Part of the deal's id, a party's name or what is bought. */
  q: z.string().trim().max(200).optional(),
  sort: z.enum(Object.keys(DEAL_SORTS) as [keyof typeof DEAL_SORTS]).default('newest'),
  /** The previous page's `next`. */
  before: Cursor.optional(),
  limit: z.coerce.number().int().min(1).max(200).default(100),
});

/**
 * A page of deals with both parties' names, in the order asked, and how many of the deals the
 * member and search select fall in each group. `funding` says whether the buyer paid by card or over
 * x402. `releaseAmount` is what was released to the seller; `settledAmount` is the principal that
 * settled in a closed cycle, null until then.
 */
export async function listDeals(tenantId: string, input: z.input<typeof ListDeals> = {}) {
  const { memberId, status, q, sort, before, limit } = parseInput(ListDeals, input);
  const { db } = deps();
  const byCard = exists(
    db
      .select({ one: sql`1` })
      .from(dealEvents)
      .where(and(eq(dealEvents.dealId, deals.id), eq(dealEvents.type, 'card_funded'))),
  );
  // Credited only once the deposit it became has been matched to it.
  const byX402 = exists(
    db
      .select({ one: sql`1` })
      .from(x402Payments)
      .where(and(eq(x402Payments.dealId, deals.id), isNotNull(x402Payments.claimedRef))),
  );
  // What settled for the deal: its principal, as released, once its cycle closed.
  const settledAmount = db
    .select({ amount: sql`sum(${obligations.amount})` })
    .from(obligations)
    .where(
      and(
        eq(obligations.dealId, deals.id),
        eq(obligations.leg, 'principal'),
        eq(obligations.status, 'settled'),
      ),
    );
  const buyer = alias(members, 'buyer');
  const seller = alias(members, 'seller');
  const buyerAgent = alias(agents, 'buyer_agent');
  const sellerAgent = alias(agents, 'seller_agent');
  // A deal's short id is the first characters of its uuid, so search ignores the prefix and dashes.
  const needle = q ? `%${q.replace(/^dl-/i, '').replace(/[\\%_]/g, (c) => `\\${c}`)}%` : undefined;
  const selected = and(
    eq(deals.tenantId, tenantId),
    memberId
      ? or(eq(deals.buyerMemberId, memberId), eq(deals.sellerMemberId, memberId))
      : undefined,
    needle
      ? or(
          sql`replace(${deals.id}::text, '-', '') ilike ${needle.replaceAll('-', '')}`,
          ilike(buyer.name, needle),
          ilike(seller.name, needle),
          sql`exists (select 1 from jsonb_array_elements(${deals.terms}->'lines') line where line->>'description' ilike ${needle})`,
        )
      : undefined,
  );
  const order = DEAL_SORTS[sort];
  const column = order.by === 'amount' ? deals.amount : deals.createdAt;
  const after = before
    ? sql`(${column}, ${deals.id}) ${sql.raw(order.desc ? '<' : '>')} (select ${column}, ${deals.id} from ${deals} where ${deals.id} = ${before} and ${deals.tenantId} = ${tenantId})`
    : undefined;
  const [rows, groups] = await Promise.all([
    db
      .select({
        deal: deals,
        byCard: sql<boolean>`${byCard}`,
        byX402: sql<boolean>`${byX402}`,
        settledAmount: sql<string | null>`(${settledAmount})`,
        buyerName: buyer.name,
        sellerName: seller.name,
        buyerAgentName: buyerAgent.name,
        sellerAgentName: sellerAgent.name,
      })
      .from(deals)
      .innerJoin(buyer, eq(buyer.id, deals.buyerMemberId))
      .innerJoin(seller, eq(seller.id, deals.sellerMemberId))
      .leftJoin(buyerAgent, eq(buyerAgent.id, deals.buyerAgentId))
      .leftJoin(sellerAgent, eq(sellerAgent.id, deals.sellerAgentId))
      .where(and(selected, status ? inArray(deals.status, DEAL_GROUPS[status]) : undefined, after))
      .orderBy(...(order.desc ? [desc(column), desc(deals.id)] : [asc(column), asc(deals.id)]))
      .limit(limit + 1),
    db
      .select({ status: deals.status, n: count() })
      .from(deals)
      .innerJoin(buyer, eq(buyer.id, deals.buyerMemberId))
      .innerJoin(seller, eq(seller.id, deals.sellerMemberId))
      .where(selected)
      .groupBy(deals.status),
  ]);
  const counted = (statuses: readonly string[]) =>
    groups.filter((g) => statuses.includes(g.status)).reduce((n, g) => n + g.n, 0);
  const counts = {
    all: groups.reduce((n, g) => n + g.n, 0),
    ...(Object.fromEntries(
      Object.entries(DEAL_GROUPS).map(([group, statuses]) => [group, counted(statuses)]),
    ) as Record<DealGroup, number>),
  };
  const page = pageOf(
    rows.map((r) => ({
      ...withTerms(r.deal),
      buyerName: r.buyerName,
      sellerName: r.sellerName,
      /** The agents that struck it for each side, if agents did. */
      buyerAgentName: r.buyerAgentName,
      sellerAgentName: r.sellerAgentName,
      settledAmount: r.settledAmount === null ? null : BigInt(r.settledAmount),
      funding: r.byCard ? ('card' as const) : r.byX402 ? ('x402' as const) : null,
    })),
    limit,
    (d) => d.id,
  );
  return { ...page, counts };
}

const PAGE_SIZE = 200;

/**
 * What has happened to a tenant's deals since the event `after`, so a platform can follow along.
 * Events are read in (transaction, seq) order and only from transactions that no snapshot can still
 * see running, so a transaction that commits later can only add events after the cursor.
 */
export async function dealEventFeed(tenantId: string, after: bigint) {
  const { db } = deps();
  const [cursor] =
    after > 0n
      ? await db
          .select({ xid: dealEvents.xid, seq: dealEvents.seq })
          .from(dealEvents)
          .where(and(eq(dealEvents.tenantId, tenantId), eq(dealEvents.seq, after)))
      : [];
  if (after > 0n && !cursor)
    throw new DomainError('invalid', 'Pass `after` as the `next` of an earlier page');
  const events = await db
    .select({
      seq: dealEvents.seq,
      dealId: dealEvents.dealId,
      type: dealEvents.type,
      payload: dealEvents.payload,
      at: dealEvents.createdAt,
    })
    .from(dealEvents)
    .where(
      and(
        eq(dealEvents.tenantId, tenantId),
        sql`${dealEvents.xid} < pg_snapshot_xmin(pg_current_snapshot())`,
        cursor
          ? sql`(${dealEvents.xid}, ${dealEvents.seq}) > (${String(cursor.xid)}::xid8, ${cursor.seq})`
          : undefined,
      ),
    )
    .orderBy(asc(dealEvents.xid), asc(dealEvents.seq))
    .limit(PAGE_SIZE);
  return { events, next: events.at(-1)?.seq ?? after };
}
