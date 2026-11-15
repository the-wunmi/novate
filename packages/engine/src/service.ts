import { randomUUID } from 'node:crypto';
import { DBOS } from '@dbos-inc/dbos-sdk';
import {
  Currency,
  DealTerms,
  DomainError,
  dealAmount,
  dealQuantity,
  describePrincipal,
  Mandate,
  MinorAmount,
  mayAssertFact,
  mayFileDocument,
  type Principal,
  parseInput,
  sha256,
  sideOf,
  TERMINAL_DEAL_STATUSES,
} from '@novate/core';
import {
  agents,
  apiKeys,
  apiRateWindows,
  cycles,
  dealEvents,
  dealFacts,
  deals,
  decisionCases,
  decisionRecords,
  ledgerAccounts,
  ledgerTransfers,
  members,
  obligations,
  programs,
  settlementInstructions,
  type Tx,
  tenants,
} from '@novate/db';
import { ProgramSpec, validateFactData } from '@novate/policy';
import {
  and,
  asc,
  count,
  desc,
  eq,
  gt,
  inArray,
  isNull,
  like,
  lt,
  max,
  ne,
  or,
  sql,
} from 'drizzle-orm';
import { z } from 'zod';
import {
  type CycleSummary,
  cycleWorkflow,
  WITHDRAWAL_OPENED,
  withdrawalWorkflow,
} from './cycle-workflow.ts';
import { railRefusal, shapeProblem } from './deal-policy.ts';
import { dealWorkflow } from './deal-workflow.ts';
import type { CaseMessage } from './decisions.ts';
import { deps, networkStep, tx } from './deps.ts';
import { hashKey, newKey } from './instance-setup.ts';
import {
  type AgentRow,
  type DealRow,
  getAgent,
  getDeal,
  getMember,
  haltSettlement,
  type MemberRow,
  memberInTenant,
  record,
} from './repo.ts';
import { stableUuid } from './settlement-group.ts';
import { Topics } from './topics.ts';

async function agentInTenant(db: Tx, tenantId: string, agentId: string): Promise<AgentRow> {
  const agent = await getAgent(db, agentId);
  if (agent.tenantId !== tenantId) throw new DomainError('not_found', 'Agent not found');
  return agent;
}

async function dealForPrincipal(dealId: string, principal: Principal): Promise<DealRow> {
  const deal = await getDeal(deps().db, dealId);
  if (deal.tenantId !== principal.tenantId) throw new DomainError('not_found', 'Deal not found');
  return deal;
}

// ── Tenancy ────────────────────────────────────────────────────────────────

export const CreateTenant = z.object({ name: z.string().min(1) });

/** Create a tenant and its platform credential. The key is returned once. */
export async function createTenant(input: z.input<typeof CreateTenant>) {
  const values = parseInput(CreateTenant, input);
  const tenant = await tx('create_tenant', async (db) => {
    const [row] = await db.insert(tenants).values(values).returning();
    return row as typeof tenants.$inferSelect;
  });
  const { key } = await issueKey(tenant.id, { name: 'platform', principal: 'platform' });
  return { tenant, apiKey: key };
}

export const CreateMember = z.object({
  name: z.string().min(1),
  homeCurrency: Currency,
  attributes: z.record(z.string(), z.unknown()).optional(),
});

export async function createMember(tenantId: string, input: z.input<typeof CreateMember>) {
  const values = parseInput(CreateMember, input);
  return tx('create_member', async (db) => {
    const [row] = await db
      .insert(members)
      .values({ ...values, tenantId })
      .returning();
    return row as MemberRow;
  });
}

/** Rail refs that decide whose money moves. A second member holding one would be an impersonation. */
const IDENTITY_REF = /_(deposit_account|account)$/;

/**
 * Record a member's identifiers on a rail, such as its Global Account and beneficiary. These decide
 * whose account is debited or credited, so only an operator-issued house key can set them.
 */
export async function setMemberRailRefs(
  tenantId: string,
  memberId: string,
  refs: Record<string, string>,
): Promise<void> {
  const values = parseInput(z.record(z.string(), z.string().min(1)), refs);
  await tx('set_member_rail_refs', async (db) => {
    const member = await memberInTenant(db, tenantId, memberId);
    for (const [key, value] of Object.entries(values)) {
      if (!IDENTITY_REF.test(key)) continue;
      await db.execute(sql`SELECT pg_advisory_xact_lock(hashtext(${`${key}:${value}`}))`);
      const [holder] = await db
        .select({ id: members.id })
        .from(members)
        .where(and(sql`${members.railRefs}->>${key} = ${value}`, ne(members.id, member.id)));
      if (holder) throw new DomainError('conflict', `${key} is already assigned`);
    }
    await db
      .update(members)
      .set({ railRefs: { ...member.railRefs, ...values } })
      .where(eq(members.id, member.id));
  });
}

/** Let a suspended member settle again. Its deferred obligations join the next cycle. */
export async function reinstateMember(tenantId: string, memberId: string): Promise<void> {
  await tx('reinstate_member', async (db) => {
    const member = await memberInTenant(db, tenantId, memberId);
    await db.update(members).set({ status: 'active' }).where(eq(members.id, member.id));
  });
}

export const ProvisionMember = z.object({
  rail: z.string().min(1),
  countryCode: z.string().length(2),
  currency: Currency,
  /** Where the member is paid, in pooled custody. */
  beneficiary: z.record(z.string(), z.unknown()).optional(),
  /** The rail's own account-opening details, in connected custody. */
  connectedAccount: z.record(z.string(), z.unknown()).optional(),
  transferMethods: z.array(z.enum(['LOCAL', 'SWIFT'])).min(1),
  /** Same key, same attempt. A failed attempt is retried under a new key. */
  idempotencyKey: z.string().min(1),
});

/** Create a member's accounts on a rail and record them. */
export async function provisionMember(
  tenantId: string,
  memberId: string,
  input: z.input<typeof ProvisionMember>,
): Promise<void> {
  const { rail: railName, idempotencyKey, ...details } = parseInput(ProvisionMember, input);
  const refusal = railRefusal(tenantId, railName);
  if (refusal) throw new DomainError('invalid', refusal);
  const rail = deps().rails.get(railName);
  if (!rail.provision)
    throw new DomainError('invalid', `Rail ${railName} cannot provision members`);
  const member = await getMember(deps().db, memberId);
  if (member.tenantId !== tenantId) throw new DomainError('not_found', 'Member not found');
  const id = stableUuid(`provision:${tenantId}:${memberId}:${idempotencyKey}`);
  await DBOS.startWorkflow(provisionWorkflow, { workflowID: id })(
    tenantId,
    member,
    railName,
    details,
  );
  await DBOS.retrieveWorkflow(id).getResult();
}

type ProvisionDetails = Omit<z.output<typeof ProvisionMember>, 'rail' | 'idempotencyKey'>;

/** Accounts created on a rail are recorded even if the process dies between the two. */
async function runProvision(
  tenantId: string,
  member: MemberRow,
  railName: string,
  details: ProvisionDetails,
): Promise<void> {
  const rail = deps().rails.get(railName);
  const refs = await networkStep('rail_provision', async () =>
    (rail.provision as NonNullable<typeof rail.provision>)({
      ...details,
      requestId: member.id,
      nickName: member.name,
    }),
  );
  await setMemberRailRefs(tenantId, member.id, refs);
}

const provisionWorkflow = DBOS.registerWorkflow(runProvision, { name: 'provisionMember' });

export const CreateAgent = z.object({
  memberId: z.string().uuid(),
  name: z.string().min(1),
  mandate: Mandate,
});

export async function createAgent(tenantId: string, input: z.input<typeof CreateAgent>) {
  const { mandate, ...values } = parseInput(CreateAgent, input);
  return tx('create_agent', async (db) => {
    await memberInTenant(db, tenantId, values.memberId);
    const [row] = await db
      .insert(agents)
      .values({ ...values, tenantId, mandate: mandate })
      .returning();
    return row as AgentRow;
  });
}

type KeyValues = {
  name: string;
  principal: Principal['kind'];
  memberId?: string;
  agentId?: string;
};

async function issueKey(tenantId: string, values: KeyValues): Promise<{ id: string; key: string }> {
  const key = newKey();
  const id = await tx('issue_key', async (db) => {
    if (values.memberId) await memberInTenant(db, tenantId, values.memberId);
    if (values.agentId) {
      const agent = await agentInTenant(db, tenantId, values.agentId);
      if (agent.memberId !== values.memberId) {
        throw new DomainError('not_found', 'Agent not found');
      }
    }
    const [row] = await db
      .insert(apiKeys)
      .values({ ...values, tenantId, keyHash: hashKey(key) })
      .returning({ id: apiKeys.id });
    return row?.id as string;
  });
  return { id, key };
}

/** `platform` and `house` keys are not issued here: they carry operator-level power. */
export const CreateApiKey = z
  .object({
    name: z.string().min(1),
    principal: z.enum(['member', 'agent', 'inspector', 'carrier', 'arbiter']),
    memberId: z.string().uuid().optional(),
    agentId: z.string().uuid().optional(),
  })
  .refine((k) => !['member', 'agent'].includes(k.principal) || k.memberId, {
    message: 'A member or agent key needs a member',
  })
  .refine((k) => k.principal !== 'agent' || k.agentId, {
    message: 'An agent key needs an agent',
  })
  // A reviewer tied to a party would be judging its own deals.
  .refine((k) => ['member', 'agent'].includes(k.principal) || (!k.memberId && !k.agentId), {
    message: 'Only member and agent keys belong to a member',
  });

/** Issue a credential. The plain key is returned once and only its hash is stored. */
export function createApiKey(tenantId: string, input: z.input<typeof CreateApiKey>) {
  return issueKey(tenantId, parseInput(CreateApiKey, input));
}

/** A house key can credit funds, so this is reachable only with the operator's credential. */
export const createHouseKey = (tenantId: string) =>
  issueKey(tenantId, { name: 'house', principal: 'house' });

/** A platform key is only shown when issued, so a lost one is replaced. */
export const createPlatformKey = (tenantId: string) =>
  issueKey(tenantId, { name: 'platform', principal: 'platform' });

export async function revokeApiKey(tenantId: string, keyId: string): Promise<void> {
  await deps()
    .db.update(apiKeys)
    .set({ revokedAt: new Date() })
    .where(and(eq(apiKeys.id, keyId), eq(apiKeys.tenantId, tenantId)));
}

export async function principalForKey(key: string): Promise<Principal | null> {
  const [row] = await deps()
    .db.select()
    .from(apiKeys)
    .where(and(eq(apiKeys.keyHash, hashKey(key)), isNull(apiKeys.revokedAt)));
  if (!row) return null;
  // A suspended agent's credential stops working with it.
  if (row.agentId && (await getAgent(deps().db, row.agentId)).status !== 'active') return null;
  return {
    kind: row.principal,
    id: row.id,
    tenantId: row.tenantId,
    memberId: row.memberId ?? undefined,
    agentId: row.agentId ?? undefined,
  };
}

/** Count a request against its credential. False once it is over the limit for this minute. */
export async function withinRateLimit(keyId: string, perMinute: number): Promise<boolean> {
  const windowStart = new Date(Math.floor(Date.now() / 60_000) * 60_000);
  const [row] = await deps()
    .db.insert(apiRateWindows)
    .values({ keyId, windowStart })
    .onConflictDoUpdate({
      target: [apiRateWindows.keyId, apiRateWindows.windowStart],
      set: { requests: sql`${apiRateWindows.requests} + 1` },
    })
    .returning({ requests: apiRateWindows.requests });
  return (row?.requests ?? 0) <= perMinute;
}

// ── Programs ───────────────────────────────────────────────────────────────

export const PublishProgram = z.object({
  key: z.string().regex(/^[a-z0-9-]+$/),
  spec: ProgramSpec,
});

/** Publish a new immutable version of a program. Deals keep the version they were accepted under. */
export async function publishProgram(tenantId: string, input: z.input<typeof PublishProgram>) {
  const { key, spec } = parseInput(PublishProgram, input);
  const refusal = railRefusal(tenantId, spec.settlement.rail);
  if (refusal) throw new DomainError('invalid', refusal);
  return tx('publish_program', async (db) => {
    const [current] = await db
      .select({ version: max(programs.version) })
      .from(programs)
      .where(and(eq(programs.tenantId, tenantId), eq(programs.key, key)));
    const [row] = await db
      .insert(programs)
      .values({
        tenantId,
        key,
        version: (current?.version ?? 0) + 1,
        spec: spec as unknown as Record<string, unknown>,
      })
      .returning();
    return row as typeof programs.$inferSelect;
  });
}

export async function latestProgram(tenantId: string, key: string) {
  const [row] = await deps()
    .db.select()
    .from(programs)
    .where(and(eq(programs.tenantId, tenantId), eq(programs.key, key)))
    .orderBy(desc(programs.version))
    .limit(1);
  if (!row) throw new DomainError('not_found', `Program ${key} not found`);
  return row;
}

// ── Funds and status ───────────────────────────────────────────────────────

export function balances(tenantId: string, memberId: string) {
  return deps().ledger.balances(deps().db, tenantId, `member:${memberId}:`);
}

export async function tenantStatus(tenantId: string) {
  const [row] = await deps().db.select().from(tenants).where(eq(tenants.id, tenantId));
  if (!row) throw new DomainError('not_found', 'Tenant not found');
  return {
    id: row.id,
    name: row.name,
    settlementHaltedAt: row.settlementHaltedAt,
    settlementHaltReason: row.settlementHaltReason,
  };
}

// ── Deals ──────────────────────────────────────────────────────────────────

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
      });
      return created;
    }
    return confirmExisting(db, tenantId, d, side, termsHash);
  });
  // The deal id is the workflow id: starting twice is a no-op.
  if (!row.awaitingSide) await DBOS.startWorkflow(dealWorkflow, { workflowID: row.id })(row.id);
  return row;
}

/** The same key again: a retry, or the other side confirming. Different terms are refused. */
async function confirmExisting(
  db: Tx,
  tenantId: string,
  d: ParsedDeal,
  side: 'buyer' | 'seller' | null,
  termsHash: string,
): Promise<DealRow> {
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
  await record(db, deal.id, 'confirmed', { side: side ?? 'operator' });
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
  const deal = await dealForPrincipal(dealId, principal);
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

async function addFact(deal: DealRow, principal: Principal, f: z.output<typeof SubmitFact>) {
  assertOpen(deal);
  const invalid = validateFactData(f.kind, f.data);
  if (invalid) throw new DomainError('invalid', invalid);
  const source = describePrincipal(principal);
  const { fact, openCaseId } = await tx('add_fact', async (db) => {
    const [existing] = await db
      .select({ n: count() })
      .from(dealFacts)
      .where(eq(dealFacts.dealId, deal.id));
    if ((existing?.n ?? 0) >= MAX_FACTS_PER_DEAL) {
      throw new DomainError('conflict', 'This deal has reached its limit of evidence');
    }
    const [row] = await db
      .insert(dealFacts)
      .values({ dealId: deal.id, ...f, source })
      .returning();
    await record(db, deal.id, 'fact_added', {
      factId: row?.id,
      kind: f.kind,
      type: f.type,
      source,
    });
    const [open] = await db
      .select({ id: decisionCases.id })
      .from(decisionCases)
      .where(and(eq(decisionCases.dealId, deal.id), eq(decisionCases.status, 'open')));
    return { fact: row as typeof dealFacts.$inferSelect, openCaseId: open?.id };
  });
  await DBOS.send(deal.id, { factId: fact.id }, Topics.fact, `fact:${fact.id}`);
  if (openCaseId) {
    const msg: CaseMessage = { type: 'evidence_changed', caseId: openCaseId };
    await DBOS.send(deal.id, msg, Topics.case, `evidence:${fact.id}`);
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
  const deal = await dealForPrincipal(dealId, principal);
  // Checked before the model is called, so nobody without standing can spend on it.
  if (!mayFileDocument(principal, deal)) throw mayNot(principal, 'document');
  assertOpen(deal);
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

export async function openCases(tenantId: string) {
  return deps()
    .db.select()
    .from(decisionCases)
    .where(and(eq(decisionCases.tenantId, tenantId), eq(decisionCases.status, 'open')))
    .orderBy(asc(decisionCases.createdAt));
}

export async function caseRecords(tenantId: string, caseId: string) {
  const { db } = deps();
  const [row] = await db.select().from(decisionCases).where(eq(decisionCases.id, caseId));
  if (row?.tenantId !== tenantId) throw new DomainError('not_found', 'Case not found');
  return db
    .select()
    .from(decisionRecords)
    .where(eq(decisionRecords.caseId, caseId))
    .orderBy(asc(decisionRecords.createdAt));
}

/** Operators see everything. Others see the deal and its evidence, not the policy or the cases. */
export async function dealDetail(dealId: string, principal: Principal) {
  const { db } = deps();
  const deal = await dealForPrincipal(dealId, principal);
  if (principal.memberId && !sideOf(principal, deal)) {
    throw new DomainError('not_found', 'Deal not found');
  }
  const [facts, obligationRows] = await Promise.all([
    db
      .select()
      .from(dealFacts)
      .where(eq(dealFacts.dealId, dealId))
      .orderBy(asc(dealFacts.createdAt)),
    db.select().from(obligations).where(eq(obligations.dealId, dealId)),
  ]);
  if (principal.kind !== 'platform' && principal.kind !== 'house') {
    const { policySnapshot: _hidden, ...visible } = deal;
    return { deal: visible, facts, obligations: obligationRows, events: [], cases: [] };
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
  return { deal, facts, obligations: obligationRows, events, cases };
}

export function listDeals(tenantId: string, limit = 100) {
  return deps()
    .db.select()
    .from(deals)
    .where(eq(deals.tenantId, tenantId))
    .orderBy(desc(deals.createdAt))
    .limit(limit);
}

// ── Cycles ─────────────────────────────────────────────────────────────────

const startGroupCycle = (tenantId: string, group: string) => {
  const cycleId = randomUUID();
  return DBOS.startWorkflow(cycleWorkflow, { workflowID: cycleId })(tenantId, cycleId, group);
};

/** Start settling everything eligible, one cycle per group, without waiting for it to finish. */
export async function startCycles(tenantId: string): Promise<string[]> {
  const handles = await Promise.all(
    (await eligibleGroups(deps().db, tenantId)).map((group) => startGroupCycle(tenantId, group)),
  );
  return handles.map((h) => h.workflowID);
}

/** Settle everything eligible now and wait for the merged result. */
export async function runCycle(tenantId: string): Promise<CycleSummary> {
  const results: CycleSummary[] = [];
  for (const group of await eligibleGroups(deps().db, tenantId)) {
    const handle = await startGroupCycle(tenantId, group);
    results.push(await handle.getResult());
  }
  return mergeSummaries(results);
}

export async function eligibleGroups(db: Tx, tenantId: string): Promise<string[]> {
  const rows = await db
    .selectDistinct({ group: obligations.settlementGroup })
    .from(obligations)
    .where(and(eq(obligations.tenantId, tenantId), eq(obligations.status, 'eligible')));
  return rows.flatMap((r) => (r.group ? [r.group] : []));
}

function mergeSummaries(results: CycleSummary[]): CycleSummary {
  const worst = (['halted', 'failed', 'deferred'] as const).find((s) =>
    results.some((r) => r.status === s),
  );
  return {
    cycleId: results[0]?.cycleId ?? '',
    status: worst ?? (results.some((r) => r.status === 'settled') ? 'settled' : 'empty'),
    obligations: results.reduce((acc, r) => acc + r.obligations, 0),
    totals: Object.assign({}, ...results.map((r) => r.totals)),
    failures: results.flatMap((r) => r.failures),
    fx: results.find((r) => r.fx)?.fx,
  };
}

export async function cycleDetail(tenantId: string, cycleId: string) {
  const { db } = deps();
  const [cycle] = await db.select().from(cycles).where(eq(cycles.id, cycleId));
  if (cycle?.tenantId !== tenantId) throw new DomainError('not_found', 'Cycle not found');
  const instructions = await db
    .select()
    .from(settlementInstructions)
    .where(eq(settlementInstructions.cycleId, cycleId));
  return { cycle, instructions };
}

export function listMembers(tenantId: string) {
  return deps().db.select().from(members).where(eq(members.tenantId, tenantId));
}

export const Withdraw = z.object({
  currency: Currency,
  amount: MinorAmount.refine((v) => v > 0n, { message: 'Amount must be positive' }),
  rail: z.string().min(1),
  /** Same key, same withdrawal: a retry cannot send the money twice. */
  idempotencyKey: z.string().min(1),
});

/** Send a member's free balance to the payout destination the house has on record for it. */
export async function requestWithdrawal(
  tenantId: string,
  memberId: string,
  input: z.input<typeof Withdraw>,
): Promise<{ id: string }> {
  const { rail, idempotencyKey, ...request } = parseInput(Withdraw, input);
  const refusal = railRefusal(tenantId, rail);
  if (refusal) throw new DomainError('invalid', refusal);
  await tx('withdrawal_member', (db) => memberInTenant(db, tenantId, memberId));
  const id = stableUuid(`withdrawal:${tenantId}:${memberId}:${idempotencyKey}`);
  await DBOS.startWorkflow(withdrawalWorkflow, { workflowID: id })(tenantId, id, rail, {
    ...request,
    memberId,
  });
  const opened = await DBOS.getEvent<{ refused?: string }>(id, WITHDRAWAL_OPENED, 30);
  if (opened?.refused) throw new DomainError('insufficient_funds', opened.refused);
  return { id };
}

export async function withdrawalDetail(tenantId: string, memberId: string, id: string) {
  const rows = await deps()
    .db.select()
    .from(settlementInstructions)
    .where(
      and(
        eq(settlementInstructions.tenantId, tenantId),
        eq(settlementInstructions.memberId, memberId),
        eq(settlementInstructions.cycleId, id),
      ),
    );
  if (!rows.length) throw new DomainError('not_found', 'Withdrawal not found');
  return rows;
}

const PAGE_SIZE = 200;

/** Every movement on a member's accounts, newest first. Credits are positive. */
export async function memberStatement(tenantId: string, memberId: string, before?: Date) {
  const { db } = deps();
  const accounts = await db
    .select({ id: ledgerAccounts.id, code: ledgerAccounts.code })
    .from(ledgerAccounts)
    .where(
      and(eq(ledgerAccounts.tenantId, tenantId), like(ledgerAccounts.code, `member:${memberId}:%`)),
    );
  if (!accounts.length) return [];
  const owned = new Map(accounts.map((a) => [a.id, a.code.split(':')[3] as string]));
  const ids = [...owned.keys()];
  const rows = await db
    .select()
    .from(ledgerTransfers)
    .where(
      and(
        or(
          inArray(ledgerTransfers.debitAccountId, ids),
          inArray(ledgerTransfers.creditAccountId, ids),
        ),
        before ? lt(ledgerTransfers.createdAt, before) : undefined,
      ),
    )
    .orderBy(desc(ledgerTransfers.createdAt))
    .limit(PAGE_SIZE);
  return rows.flatMap((t) => {
    const line = (account: string, amount: bigint) => ({
      at: t.createdAt,
      kind: t.kind,
      ref: t.ref,
      account,
      currency: t.currency,
      amount,
    });
    const debit = owned.get(t.debitAccountId);
    const credit = owned.get(t.creditAccountId);
    return [
      ...(debit ? [line(debit, -t.amount)] : []),
      ...(credit ? [line(credit, t.amount)] : []),
    ];
  });
}

/** Sequence numbers are taken before commit, so the newest moments are held back from the feed. */
const FEED_SETTLE_MS = 5_000;

/** What has happened to a tenant's deals since `after`, in order, so a platform can follow along. */
export async function dealEventFeed(tenantId: string, after: bigint) {
  const events = await deps()
    .db.select({
      seq: dealEvents.seq,
      dealId: dealEvents.dealId,
      type: dealEvents.type,
      payload: dealEvents.payload,
      at: dealEvents.createdAt,
    })
    .from(dealEvents)
    .innerJoin(deals, eq(deals.id, dealEvents.dealId))
    .where(
      and(
        eq(deals.tenantId, tenantId),
        gt(dealEvents.seq, after),
        lt(dealEvents.createdAt, new Date(Date.now() - FEED_SETTLE_MS)),
      ),
    )
    .orderBy(asc(dealEvents.seq))
    .limit(PAGE_SIZE);
  return { events, next: events.at(-1)?.seq ?? after };
}

export async function setAgentStatus(
  tenantId: string,
  agentId: string,
  status: 'active' | 'blocked',
): Promise<void> {
  const [row] = await deps()
    .db.update(agents)
    .set({ status })
    .where(and(eq(agents.id, agentId), eq(agents.tenantId, tenantId)))
    .returning({ id: agents.id });
  if (!row) throw new DomainError('not_found', 'Agent not found');
}

export async function listAgents(tenantId: string) {
  return deps().db.select().from(agents).where(eq(agents.tenantId, tenantId));
}

/** Stop a member settling. Its deals wait, as they do after a default, until it is reinstated. */
export async function suspendMember(tenantId: string, memberId: string): Promise<void> {
  await tx('suspend_member', async (db) => {
    const member = await memberInTenant(db, tenantId, memberId);
    await db.update(members).set({ status: 'suspended' }).where(eq(members.id, member.id));
  });
}

export const StopSettlement = z.object({ reason: z.string().min(1).max(500) });

/** The manual stop. Settlement stays stopped until someone resumes it. */
export async function stopSettlement(
  tenantId: string,
  input: z.input<typeof StopSettlement>,
): Promise<void> {
  const { reason } = parseInput(StopSettlement, input);
  await tx('stop_settlement', (db) => haltSettlement(db, tenantId, reason));
}

export async function checkDatabase(): Promise<void> {
  await deps().db.execute(sql`select 1`);
}
