import { toJson } from '@novate/core';
import { sql } from 'drizzle-orm';
import {
  bigint,
  bigserial,
  boolean,
  check,
  customType,
  index,
  integer,
  numeric,
  pgEnum,
  pgTable,
  text,
  timestamp,
  uniqueIndex,
  uuid,
} from 'drizzle-orm/pg-core';

const id = () => uuid('id').primaryKey().defaultRandom();
const createdAt = () => timestamp('created_at', { withTimezone: true }).notNull().defaultNow();
const updatedAt = () =>
  timestamp('updated_at', { withTimezone: true })
    .notNull()
    .defaultNow()
    .$onUpdate(() => new Date());
const money = (name: string) => bigint(name, { mode: 'bigint' });
/** Postgres JSON, written so that amounts held as bigint are stored as strings of minor units. */
const jsonb = customType<{ data: unknown; driverData: string }>({
  dataType: () => 'jsonb',
  toDriver: toJson,
});

// ── Tenancy ────────────────────────────────────────────────────────────────

/** A platform (marketplace, agentic-commerce provider) that embeds the clearing house. */
export const tenants = pgTable('tenants', {
  id: id(),
  name: text('name').notNull(),
  /** Set when reconciliation or an operator stops new settlement for this tenant. */
  settlementHaltedAt: timestamp('settlement_halted_at', { withTimezone: true }),
  settlementHaltReason: text('settlement_halt_reason'),
  createdAt: createdAt(),
});

/** One row, written by the first boot. No row means this installation has not been set up. */
export const instanceSetup = pgTable('instance_setup', {
  id: boolean('id').primaryKey().default(true),
  /** Owns every rail this installation runs. */
  defaultTenantId: uuid('default_tenant_id')
    .notNull()
    .references(() => tenants.id),
  /** The key that may create tenants and issue their first credentials. */
  operatorKeyHash: text('operator_key_hash').notNull(),
  createdAt: createdAt(),
});

/** A payment made over x402, kept so the deposit it becomes can be credited to the right member. */
export const x402Payments = pgTable(
  'x402_payments',
  {
    id: id(),
    tenantId: uuid('tenant_id')
      .notNull()
      .references(() => tenants.id),
    dealId: uuid('deal_id')
      .notNull()
      .references(() => deals.id),
    memberId: uuid('member_id')
      .notNull()
      .references(() => members.id),
    rail: text('rail').notNull(),
    payer: text('payer').notNull(),
    amount: money('amount').notNull(),
    signatureHash: text('signature_hash').notNull(),
    status: text('status', { enum: ['pending', 'settled', 'refused'] })
      .notNull()
      .default('pending'),
    txHash: text('tx_hash'),
    /** The finalized deposit this became. Set once, so it can only be credited once. */
    claimedRef: text('claimed_ref'),
    reason: text('reason'),
    createdAt: createdAt(),
  },
  (t) => [
    uniqueIndex('x402_payments_signature_uq').on(t.signatureHash),
    uniqueIndex('x402_payments_claimed_uq').on(t.claimedRef),
    index('x402_payments_payer_idx').on(t.rail, t.payer),
  ],
);

/**
 * A deal funded with a Visa Intelligent Commerce credential from Airi. The card itself is never
 * stored. `settledAt` is when the money reached the rail balance, which is after it was captured.
 */
export const cardPayments = pgTable(
  'card_payments',
  {
    id: id(),
    tenantId: uuid('tenant_id')
      .notNull()
      .references(() => tenants.id),
    dealId: uuid('deal_id')
      .notNull()
      .references(() => deals.id),
    memberId: uuid('member_id')
      .notNull()
      .references(() => members.id),
    rail: text('rail').notNull(),
    mandateId: text('mandate_id').notNull(),
    amount: money('amount').notNull(),
    currency: text('currency').notNull(),
    status: text('status', { enum: ['open', 'succeeded', 'failed'] })
      .notNull()
      .default('open'),
    intentId: text('intent_id'),
    /** What the rail's transactions call this payment, once it has been attempted. */
    attemptRef: text('attempt_ref'),
    reason: text('reason'),
    settledAt: timestamp('settled_at', { withTimezone: true }),
    createdAt: createdAt(),
  },
  (t) => [
    uniqueIndex('card_payments_mandate_uq').on(t.mandateId),
    uniqueIndex('card_payments_one_open_uq').on(t.dealId).where(sql`${t.status} = 'open'`),
    index('card_payments_intent_idx').on(t.intentId),
    index('card_payments_tenant_status_idx').on(t.tenantId, t.status),
  ],
);

/** Requests per credential per minute, shared by every API process. */
export const apiRateWindows = pgTable(
  'api_rate_windows',
  {
    keyId: text('key_id').notNull(),
    windowStart: timestamp('window_start', { withTimezone: true }).notNull(),
    requests: integer('requests').notNull().default(1),
  },
  (t) => [uniqueIndex('api_rate_windows_uq').on(t.keyId, t.windowStart)],
);

/** Credentials. Only the hash is stored; the principal decides what the bearer may do. */
export const apiKeys = pgTable(
  'api_keys',
  {
    id: id(),
    tenantId: uuid('tenant_id')
      .notNull()
      .references(() => tenants.id),
    keyHash: text('key_hash').notNull(),
    name: text('name').notNull(),
    principal: text('principal', {
      enum: ['platform', 'house', 'member', 'agent', 'inspector', 'carrier', 'arbiter'],
    }).notNull(),
    memberId: uuid('member_id').references(() => members.id),
    agentId: uuid('agent_id').references(() => agents.id),
    revokedAt: timestamp('revoked_at', { withTimezone: true }),
    createdAt: createdAt(),
  },
  (t) => [uniqueIndex('api_keys_hash_uq').on(t.keyHash)],
);

/** A business trading on a tenant's platform. */
export const members = pgTable(
  'members',
  {
    id: id(),
    tenantId: uuid('tenant_id')
      .notNull()
      .references(() => tenants.id),
    name: text('name').notNull(),
    homeCurrency: text('home_currency').notNull(),
    status: text('status', { enum: ['active', 'close_only', 'suspended'] })
      .notNull()
      .default('active'),
    /** Rail-specific references, e.g. Airwallex connected account id. */
    railRefs: jsonb('rail_refs').$type<Record<string, string>>().notNull().default({}),
    attributes: jsonb('attributes').$type<Record<string, unknown>>().notNull().default({}),
    createdAt: createdAt(),
  },
  (t) => [index('members_tenant_idx').on(t.tenantId)],
);

export const agents = pgTable(
  'agents',
  {
    id: id(),
    tenantId: uuid('tenant_id')
      .notNull()
      .references(() => tenants.id),
    memberId: uuid('member_id')
      .notNull()
      .references(() => members.id),
    name: text('name').notNull(),
    /** Validated against core `Mandate`. Amounts stored as strings of minor units. */
    mandate: jsonb('mandate').$type<Record<string, unknown>>().notNull(),
    status: text('status', { enum: ['active', 'blocked'] })
      .notNull()
      .default('active'),
    createdAt: createdAt(),
  },
  (t) => [index('agents_member_idx').on(t.memberId)],
);

// ── Programs (versioned policy) ────────────────────────────────────────────

export const programs = pgTable(
  'programs',
  {
    id: id(),
    tenantId: uuid('tenant_id')
      .notNull()
      .references(() => tenants.id),
    key: text('key').notNull(),
    version: integer('version').notNull(),
    /** Validated against policy `ProgramSpec`. Immutable once written. */
    spec: jsonb('spec').$type<Record<string, unknown>>().notNull(),
    createdAt: createdAt(),
  },
  (t) => [uniqueIndex('programs_key_version_uq').on(t.tenantId, t.key, t.version)],
);

// ── Deals ──────────────────────────────────────────────────────────────────

export const dealStatus = pgEnum('deal_status', [
  'submitted',
  'authorised',
  'frozen',
  'awaiting_funding',
  'awaiting_conditions',
  'held',
  'eligible',
  'settling',
  'settled',
  'cancelled',
  'rejected',
  'refunded',
  'exception',
]);

export const deals = pgTable(
  'deals',
  {
    id: id(),
    tenantId: uuid('tenant_id')
      .notNull()
      .references(() => tenants.id),
    idempotencyKey: text('idempotency_key').notNull(),
    programId: uuid('program_id')
      .notNull()
      .references(() => programs.id),
    buyerMemberId: uuid('buyer_member_id')
      .notNull()
      .references(() => members.id),
    sellerMemberId: uuid('seller_member_id')
      .notNull()
      .references(() => members.id),
    buyerAgentId: uuid('buyer_agent_id').references(() => agents.id),
    sellerAgentId: uuid('seller_agent_id').references(() => agents.id),
    currency: text('currency').notNull(),
    amount: money('amount').notNull(),
    quantity: integer('quantity').notNull(),
    terms: jsonb('terms').$type<Record<string, unknown>>().notNull(),
    status: dealStatus('status').notNull().default('submitted'),
    /** Resolved policy + the signal values it was resolved from. Written once, at acceptance. */
    policySnapshot: jsonb('policy_snapshot').$type<Record<string, unknown>>(),
    /** Amount that will actually settle (after partial release); null until conditions resolve. */
    releaseAmount: money('release_amount'),
    /** Hash of what was submitted. The other side has to submit the same thing to confirm it. */
    termsHash: text('terms_hash'),
    /** The side that has yet to confirm. Nothing runs and nothing moves until this is null. */
    awaitingSide: text('awaiting_side', { enum: ['buyer', 'seller'] }),
    /** Set inside the authority check, so concurrent deals count against the agent's limits. */
    authorityPassedAt: timestamp('authority_passed_at', { withTimezone: true }),
    /** Currencies the buyer's funds and the seller's margin are actually locked in. */
    fundingCurrency: text('funding_currency'),
    marginCurrency: text('margin_currency'),
    statusReason: text('status_reason'),
    /** Which trusted agent key signed a submission of this deal, if one did. */
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [
    uniqueIndex('deals_idempotency_uq').on(t.tenantId, t.idempotencyKey),
    index('deals_buyer_idx').on(t.buyerMemberId),
    index('deals_seller_idx').on(t.sellerMemberId),
    index('deals_buyer_agent_idx').on(t.buyerAgentId),
    check('deals_amount_positive', sql`${t.amount} > 0`),
  ],
);

/** Append-only audit trail of everything that happened to a deal. */
export const dealEvents = pgTable(
  'deal_events',
  {
    id: id(),
    /** The order events were written in, for a feed that can be read from where it stopped. */
    seq: bigserial('seq', { mode: 'bigint' }).notNull(),
    dealId: uuid('deal_id')
      .notNull()
      .references(() => deals.id),
    type: text('type').notNull(),
    payload: jsonb('payload').$type<Record<string, unknown>>().notNull().default({}),
    createdAt: createdAt(),
  },
  (t) => [
    index('deal_events_deal_idx').on(t.dealId, t.createdAt),
    index('deal_events_seq_idx').on(t.seq),
  ],
);

/** Evidence submitted against a deal: documents, inspection results, tracking, acceptance. */
export const dealFacts = pgTable(
  'deal_facts',
  {
    id: id(),
    dealId: uuid('deal_id')
      .notNull()
      .references(() => deals.id),
    kind: text('kind').notNull(),
    type: text('type').notNull(),
    source: text('source').notNull(),
    data: jsonb('data').$type<Record<string, unknown>>().notNull(),
    createdAt: createdAt(),
  },
  (t) => [index('deal_facts_deal_idx').on(t.dealId)],
);

/** Something that needs a decision. Its binding hash covers exactly what a decider is shown. */
export const decisionCases = pgTable(
  'decision_cases',
  {
    id: id(),
    tenantId: uuid('tenant_id')
      .notNull()
      .references(() => tenants.id),
    kind: text('kind').notNull(),
    subjectType: text('subject_type', {
      enum: ['deal', 'member', 'agent', 'cycle', 'rail', 'group'],
    }).notNull(),
    subjectId: text('subject_id').notNull(),
    dealId: uuid('deal_id').references(() => deals.id),
    reason: text('reason').notNull(),
    bindingHash: text('binding_hash').notNull(),
    shown: jsonb('shown').$type<Record<string, unknown>>().notNull(),
    /** Inputs needed to validate an action later: amount, ceiling, limits, findings. */
    context: jsonb('context').$type<Record<string, unknown>>().notNull(),
    status: text('status', { enum: ['open', 'decided', 'expired', 'stale'] })
      .notNull()
      .default('open'),
    resolution: jsonb('resolution').$type<Record<string, unknown>>(),
    /** Too early to judge how this turned out. Look again after this. */
    judgeAfter: timestamp('judge_after', { withTimezone: true }),
    createdAt: createdAt(),
    closedAt: timestamp('closed_at', { withTimezone: true }),
  },
  (t) => [
    index('decision_cases_tenant_idx').on(t.tenantId, t.status),
    index('decision_cases_deal_idx').on(t.dealId),
  ],
);

/** Append-only: every proposal any decider made, accepted or refused, and why. */
export const decisionRecords = pgTable(
  'decision_records',
  {
    id: id(),
    caseId: uuid('case_id')
      .notNull()
      .references(() => decisionCases.id),
    deciderType: text('decider_type', { enum: ['rule', 'model', 'person', 'system'] }).notNull(),
    deciderId: text('decider_id').notNull(),
    action: jsonb('action').$type<Record<string, unknown>>().notNull(),
    rationale: text('rationale').notNull(),
    bindingHash: text('binding_hash').notNull(),
    accepted: integer('accepted').notNull(),
    violations: jsonb('violations').$type<string[]>().notNull().default([]),
    metadata: jsonb('metadata').$type<Record<string, unknown>>().notNull().default({}),
    createdAt: createdAt(),
  },
  (t) => [index('decision_records_case_idx').on(t.caseId)],
);

/** How a decision turned out, judged once enough time has passed. Append-only. */
export const decisionOutcomes = pgTable(
  'decision_outcomes',
  {
    caseId: uuid('case_id')
      .primaryKey()
      .references(() => decisionCases.id),
    tenantId: uuid('tenant_id')
      .notNull()
      .references(() => tenants.id),
    kind: text('kind').notNull(),
    actionType: text('action_type').notNull(),
    verdict: text('verdict', { enum: ['good', 'bad', 'neutral'] }).notNull(),
    signals: jsonb('signals').$type<Record<string, unknown>>().notNull(),
    /** Null for decisions that belong to no one program, such as a reconciliation break. */
    programKey: text('program_key'),
    amount: money('amount').notNull().default(sql`0`),
    currency: text('currency').notNull().default(''),
    /** The two members of the deal, sorted, so one pair's successes can be capped. */
    pair: text('pair'),
    createdAt: createdAt(),
  },
  (t) => [index('decision_outcomes_tenant_kind_idx').on(t.tenantId, t.kind, t.createdAt)],
);

/** Past decisions replayed against a candidate. Moves no money and changes no case. */
export const shadowRuns = pgTable(
  'shadow_runs',
  {
    id: id(),
    tenantId: uuid('tenant_id')
      .notNull()
      .references(() => tenants.id),
    status: text('status', { enum: ['running', 'done', 'failed'] })
      .notNull()
      .default('running'),
    candidate: jsonb('candidate').$type<Record<string, unknown>>().notNull(),
    summary: jsonb('summary').$type<Record<string, unknown>>(),
    createdAt: createdAt(),
    finishedAt: timestamp('finished_at', { withTimezone: true }),
  },
  (t) => [
    index('shadow_runs_tenant_idx').on(t.tenantId, t.createdAt),
    uniqueIndex('shadow_runs_one_running_uq').on(t.tenantId).where(sql`${t.status} = 'running'`),
  ],
);

export const shadowResults = pgTable(
  'shadow_results',
  {
    runId: uuid('run_id')
      .notNull()
      .references(() => shadowRuns.id),
    caseId: uuid('case_id')
      .notNull()
      .references(() => decisionCases.id),
    recorded: text('recorded').notNull(),
    candidate: text('candidate').notNull(),
    rationale: text('rationale'),
    /** How the original decision turned out, if that is known yet. */
    verdict: text('verdict', { enum: ['good', 'bad', 'neutral'] }),
    violations: jsonb('violations').$type<string[]>().notNull().default([]),
    createdAt: createdAt(),
  },
  (t) => [uniqueIndex('shadow_results_run_case_uq').on(t.runId, t.caseId)],
);

// ── Obligations, cycles, settlement ────────────────────────────────────────

/** A novated payable: payer owes the house, the house owes the payee. */
export const obligations = pgTable(
  'obligations',
  {
    id: id(),
    tenantId: uuid('tenant_id')
      .notNull()
      .references(() => tenants.id),
    dealId: uuid('deal_id')
      .notNull()
      .references(() => deals.id),
    payerMemberId: uuid('payer_member_id')
      .notNull()
      .references(() => members.id),
    payeeMemberId: uuid('payee_member_id')
      .notNull()
      .references(() => members.id),
    currency: text('currency').notNull(),
    amount: money('amount').notNull(),
    /** `principal` is the deal itself; other legs are fees or third-party shares. */
    leg: text('leg').notNull().default('principal'),
    /** Obligations settle together only within a group (rail, netting, timing). */
    settlementGroup: text('settlement_group'),
    status: text('status', { enum: ['pending', 'eligible', 'netted', 'settled', 'cancelled'] })
      .notNull()
      .default('pending'),
    cycleId: uuid('cycle_id'),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [
    uniqueIndex('obligations_deal_leg_uq').on(t.dealId, t.leg),
    index('obligations_eligible_idx').on(t.tenantId, t.status),
  ],
);

export const cycles = pgTable(
  'cycles',
  {
    id: id(),
    tenantId: uuid('tenant_id')
      .notNull()
      .references(() => tenants.id),
    status: text('status', {
      enum: ['netting', 'settling', 'committed', 'settled', 'failed', 'deferred'],
    })
      .notNull()
      .default('netting'),
    settlementGroup: text('settlement_group'),
    summary: jsonb('summary').$type<Record<string, unknown>>(),
    createdAt: createdAt(),
    closedAt: timestamp('closed_at', { withTimezone: true }),
  },
  (t) => [index('cycles_tenant_idx').on(t.tenantId)],
);

export const settlementInstructions = pgTable(
  'settlement_instructions',
  {
    id: id(),
    tenantId: uuid('tenant_id')
      .notNull()
      .references(() => tenants.id),
    cycleId: uuid('cycle_id')
      .notNull()
      .references(() => cycles.id),
    memberId: uuid('member_id')
      .notNull()
      .references(() => members.id),
    direction: text('direction', { enum: ['collect', 'payout'] }).notNull(),
    currency: text('currency').notNull(),
    amount: money('amount').notNull(),
    rail: text('rail').notNull(),
    status: text('status', {
      enum: ['pending', 'submitted', 'confirmed', 'failed', 'reversed', 'in_doubt'],
    })
      .notNull()
      .default('pending'),
    attempt: integer('attempt').notNull().default(0),
    externalRef: text('external_ref'),
    idempotencyKey: text('idempotency_key').notNull(),
    failureReason: text('failure_reason'),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [
    uniqueIndex('settlement_instructions_idem_uq').on(t.idempotencyKey),
    index('settlement_instructions_cycle_idx').on(t.cycleId),
    index('settlement_instructions_ref_idx').on(t.externalRef),
    check('settlement_instructions_amount_positive', sql`${t.amount} > 0`),
  ],
);

/** A real currency conversion the house made on a rail for a cycle. */
export const fxConversions = pgTable(
  'fx_conversions',
  {
    id: id(),
    tenantId: uuid('tenant_id')
      .notNull()
      .references(() => tenants.id),
    cycleId: uuid('cycle_id')
      .notNull()
      .references(() => cycles.id),
    rail: text('rail').notNull(),
    sellCurrency: text('sell_currency').notNull(),
    buyCurrency: text('buy_currency').notNull(),
    sellAmount: money('sell_amount').notNull(),
    buyAmount: money('buy_amount').notNull(),
    /** Buy-currency major units per sell-currency major unit, times 10^8. */
    rateE8: money('rate_e8').notNull(),
    status: text('status', { enum: ['submitted', 'confirmed', 'failed'] })
      .notNull()
      .default('submitted'),
    externalRef: text('external_ref'),
    idempotencyKey: text('idempotency_key').notNull(),
    createdAt: createdAt(),
  },
  (t) => [uniqueIndex('fx_conversions_idem_uq').on(t.idempotencyKey)],
);

/** Rates sampled from a rail over time, from which volatility is measured. */
export const fxRateSamples = pgTable(
  'fx_rate_samples',
  {
    id: id(),
    sellCurrency: text('sell_currency').notNull(),
    buyCurrency: text('buy_currency').notNull(),
    rateE8: money('rate_e8').notNull(),
    sampledAt: timestamp('sampled_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [index('fx_rate_samples_pair_idx').on(t.sellCurrency, t.buyCurrency, t.sampledAt)],
);

/** The rate each member's side of a deal was first valued at, for mark-to-market. */
export const positionMarks = pgTable(
  'position_marks',
  {
    dealId: uuid('deal_id')
      .notNull()
      .references(() => deals.id),
    memberId: uuid('member_id')
      .notNull()
      .references(() => members.id),
    rateE8: money('rate_e8').notNull(),
    createdAt: createdAt(),
  },
  (t) => [uniqueIndex('position_marks_deal_member_uq').on(t.dealId, t.memberId)],
);

/** A portfolio margin shortfall a member's wallet could not cover. At most one open per member. */
export const marginCalls = pgTable(
  'margin_calls',
  {
    id: id(),
    tenantId: uuid('tenant_id')
      .notNull()
      .references(() => tenants.id),
    memberId: uuid('member_id')
      .notNull()
      .references(() => members.id),
    currency: text('currency').notNull(),
    amount: money('amount').notNull(),
    status: text('status', { enum: ['open', 'met', 'defaulted'] })
      .notNull()
      .default('open'),
    dueAt: timestamp('due_at', { withTimezone: true }).notNull(),
    extensions: integer('extensions').notNull().default(0),
    createdAt: createdAt(),
    closedAt: timestamp('closed_at', { withTimezone: true }),
  },
  (t) => [
    uniqueIndex('margin_calls_one_open_uq').on(t.memberId).where(sql`${t.status} = 'open'`),
    index('margin_calls_tenant_status_idx').on(t.tenantId, t.status),
  ],
);

/** Money received on a rail account that no member could be matched to. */
export const unattributedDeposits = pgTable(
  'unattributed_deposits',
  {
    id: id(),
    tenantId: uuid('tenant_id')
      .notNull()
      .references(() => tenants.id),
    rail: text('rail').notNull(),
    externalRef: text('external_ref').notNull(),
    depositAccountRef: text('deposit_account_ref').notNull(),
    currency: text('currency').notNull(),
    amount: money('amount').notNull(),
    status: text('status', { enum: ['open', 'assigned', 'reversed'] })
      .notNull()
      .default('open'),
    memberId: uuid('member_id').references(() => members.id),
    createdAt: createdAt(),
  },
  (t) => [
    uniqueIndex('unattributed_deposits_ref_uq').on(t.rail, t.externalRef),
    index('unattributed_deposits_tenant_status_idx').on(t.tenantId, t.status),
  ],
);

/** Inbox for rail webhooks. Delivery repeats and arrives out of order; this makes it safe. */
export const railEvents = pgTable(
  'rail_events',
  {
    id: id(),
    rail: text('rail').notNull(),
    externalId: text('external_id').notNull(),
    type: text('type').notNull(),
    payload: jsonb('payload').$type<Record<string, unknown>>().notNull(),
    occurredAt: timestamp('occurred_at', { withTimezone: true }).notNull(),
    processedAt: timestamp('processed_at', { withTimezone: true }),
    outcome: text('outcome'),
    createdAt: createdAt(),
  },
  (t) => [uniqueIndex('rail_events_external_uq').on(t.rail, t.externalId)],
);

/** Signed payments saved before broadcast, for rails where the network has no idempotency key. */
export const railOutgoingAttempts = pgTable(
  'rail_outgoing_attempts',
  {
    id: id(),
    rail: text('rail').notNull(),
    idempotencyKey: text('idempotency_key').notNull(),
    txHash: text('tx_hash').notNull(),
    nonce: bigint('nonce', { mode: 'number' }).notNull(),
    raw: text('raw').notNull(),
    recipient: text('recipient').notNull(),
    value: numeric('value', { precision: 78, scale: 0 }).notNull(),
    fee: numeric('fee', { precision: 78, scale: 0 }),
    createdAt: createdAt(),
  },
  (t) => [
    uniqueIndex('rail_outgoing_key_uq').on(t.rail, t.idempotencyKey),
    uniqueIndex('rail_outgoing_hash_uq').on(t.rail, t.txHash),
    uniqueIndex('rail_outgoing_nonce_uq').on(t.rail, t.nonce),
  ],
);

/** How far a polled rail has been read. Moved only after its events are safely recorded. */
export const railCursors = pgTable('rail_cursors', {
  rail: text('rail').primaryKey(),
  position: bigint('position', { mode: 'bigint' }).notNull(),
});

/** One comparison of the ledger with what a rail reports. */
export const reconRuns = pgTable(
  'recon_runs',
  {
    id: id(),
    tenantId: uuid('tenant_id')
      .notNull()
      .references(() => tenants.id),
    rail: text('rail').notNull(),
    /** `opening` records what the account already held when the rail was connected. */
    status: text('status', { enum: ['clean', 'breaks', 'failed', 'opening'] }).notNull(),
    summary: jsonb('summary').$type<Record<string, unknown>>().notNull().default({}),
    createdAt: createdAt(),
  },
  (t) => [index('recon_runs_tenant_idx').on(t.tenantId, t.createdAt)],
);

export const reconBreaks = pgTable(
  'recon_breaks',
  {
    id: id(),
    runId: uuid('run_id')
      .notNull()
      .references(() => reconRuns.id),
    tenantId: uuid('tenant_id')
      .notNull()
      .references(() => tenants.id),
    kind: text('kind', {
      enum: ['balance_mismatch', 'missing_on_rail', 'missing_in_ledger', 'amount_mismatch'],
    }).notNull(),
    currency: text('currency').notNull(),
    expected: money('expected').notNull(),
    actual: money('actual').notNull(),
    externalRef: text('external_ref'),
    detail: jsonb('detail').$type<Record<string, unknown>>().notNull().default({}),
    createdAt: createdAt(),
  },
  (t) => [index('recon_breaks_run_idx').on(t.runId)],
);

// ── Ledger (double-entry, append-only) ─────────────────────────────────────

export const ledgerAccounts = pgTable(
  'ledger_accounts',
  {
    id: id(),
    tenantId: uuid('tenant_id')
      .notNull()
      .references(() => tenants.id),
    /** Stable human key, e.g. `member:<id>:EUR:available`, `deal:<id>:escrow`. */
    code: text('code').notNull(),
    currency: text('currency').notNull(),
    /** Liability accounts (what the house owes) are credit-normal; asset accounts are debit-normal. */
    normal: text('normal', { enum: ['credit', 'debit'] }).notNull(),
    /** When set, the account may never go below zero on its normal side. */
    noOverdraft: integer('no_overdraft').notNull().default(1),
    debitsPosted: money('debits_posted').notNull().default(sql`0`),
    creditsPosted: money('credits_posted').notNull().default(sql`0`),
    createdAt: createdAt(),
  },
  (t) => [
    uniqueIndex('ledger_accounts_code_uq').on(t.tenantId, t.code),
    check(
      'ledger_accounts_overdraft',
      sql`${t.noOverdraft} = 0 OR (CASE WHEN ${t.normal} = 'credit' THEN ${t.creditsPosted} - ${t.debitsPosted} ELSE ${t.debitsPosted} - ${t.creditsPosted} END) >= 0`,
    ),
  ],
);

export const ledgerTransfers = pgTable(
  'ledger_transfers',
  {
    id: id(),
    tenantId: uuid('tenant_id')
      .notNull()
      .references(() => tenants.id),
    /** Groups transfers that were posted atomically together. */
    batchId: uuid('batch_id').notNull(),
    idempotencyKey: text('idempotency_key').notNull(),
    debitAccountId: uuid('debit_account_id')
      .notNull()
      .references(() => ledgerAccounts.id),
    creditAccountId: uuid('credit_account_id')
      .notNull()
      .references(() => ledgerAccounts.id),
    currency: text('currency').notNull(),
    amount: money('amount').notNull(),
    kind: text('kind').notNull(),
    ref: text('ref'),
    createdAt: createdAt(),
  },
  (t) => [
    uniqueIndex('ledger_transfers_idem_uq').on(t.tenantId, t.idempotencyKey),
    index('ledger_transfers_debit_idx').on(t.debitAccountId),
    index('ledger_transfers_credit_idx').on(t.creditAccountId),
    index('ledger_transfers_ref_idx').on(t.ref),
    check('ledger_transfers_amount_positive', sql`${t.amount} > 0`),
    check('ledger_transfers_distinct', sql`${t.debitAccountId} <> ${t.creditAccountId}`),
  ],
);
