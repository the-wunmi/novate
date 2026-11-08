import { sql } from 'drizzle-orm';
import {
  bigint,
  check,
  index,
  integer,
  jsonb,
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

// ── Tenancy ────────────────────────────────────────────────────────────────

/** A platform (marketplace, agentic-commerce provider) that embeds the clearing house. */
export const tenants = pgTable('tenants', {
  id: id(),
  name: text('name').notNull(),
  createdAt: createdAt(),
});

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
    status: text('status', { enum: ['active', 'suspended'] })
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
    statusReason: text('status_reason'),
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
    dealId: uuid('deal_id')
      .notNull()
      .references(() => deals.id),
    type: text('type').notNull(),
    payload: jsonb('payload').$type<Record<string, unknown>>().notNull().default({}),
    createdAt: createdAt(),
  },
  (t) => [index('deal_events_deal_idx').on(t.dealId, t.createdAt)],
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

export const approvals = pgTable(
  'approvals',
  {
    id: id(),
    dealId: uuid('deal_id')
      .notNull()
      .references(() => deals.id),
    reason: text('reason').notNull(),
    /** sha256 over exactly what the approver was shown — amount, currency, counterparty, facts. */
    bindingHash: text('binding_hash').notNull(),
    shown: jsonb('shown').$type<Record<string, unknown>>().notNull(),
    status: text('status', { enum: ['pending', 'decided', 'expired'] })
      .notNull()
      .default('pending'),
    decision: jsonb('decision').$type<Record<string, unknown>>(),
    decidedBy: text('decided_by'),
    createdAt: createdAt(),
    decidedAt: timestamp('decided_at', { withTimezone: true }),
  },
  (t) => [index('approvals_deal_idx').on(t.dealId)],
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
    status: text('status', { enum: ['pending', 'eligible', 'netted', 'settled', 'cancelled'] })
      .notNull()
      .default('pending'),
    cycleId: uuid('cycle_id'),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [
    uniqueIndex('obligations_deal_uq').on(t.dealId),
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
    status: text('status', { enum: ['netting', 'settling', 'settled', 'failed'] })
      .notNull()
      .default('netting'),
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
    status: text('status', { enum: ['pending', 'submitted', 'confirmed', 'failed'] })
      .notNull()
      .default('pending'),
    externalRef: text('external_ref'),
    idempotencyKey: text('idempotency_key').notNull(),
    failureReason: text('failure_reason'),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [
    uniqueIndex('settlement_instructions_idem_uq').on(t.idempotencyKey),
    index('settlement_instructions_cycle_idx').on(t.cycleId),
    check('settlement_instructions_amount_positive', sql`${t.amount} > 0`),
  ],
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
