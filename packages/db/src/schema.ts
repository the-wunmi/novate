import {
  type CaseDecision,
  type ControlActor,
  type FactData,
  PRINCIPAL_KINDS,
  type RecordMetadata,
  type StoredAction,
  type StoredDealTerms,
  type StoredMandate,
  type StoredTenantSettings,
  toJson,
  USER_ROLES,
} from '@novate/core';
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
/** A Postgres transaction id, 64 bits, so it never wraps. */
const xid8 = customType<{ data: bigint; driverData: string }>({
  dataType: () => 'xid8',
  fromDriver: (v) => BigInt(v),
});

// ── Tenancy ────────────────────────────────────────────────────────────────

/** A platform (marketplace, agentic-commerce provider) that embeds the clearing house. */
export const tenants = pgTable('tenants', {
  id: id(),
  name: text('name').notNull(),
  /** Set when reconciliation or an operator stops new settlement for this tenant. */
  settlementHaltedAt: timestamp('settlement_halted_at', { withTimezone: true }),
  settlementHaltReason: text('settlement_halt_reason'),
  /** Controls the house sets for itself, read through `TenantSettings`. Changed only with a control event. */
  settings: jsonb('settings').$type<StoredTenantSettings>().notNull().default({}),
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
    index('card_payments_attempt_ref_idx').on(t.attemptRef),
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
    principal: text('principal', { enum: PRINCIPAL_KINDS }).notNull(),
    memberId: uuid('member_id').references(() => members.id),
    agentId: uuid('agent_id').references(() => agents.id),
    revokedAt: timestamp('revoked_at', { withTimezone: true }),
    revokedBy: jsonb('revoked_by').$type<ControlActor>(),
    createdBy: jsonb('created_by').$type<ControlActor>().notNull(),
    /** Moved forward at most once a minute. */
    lastUsedAt: timestamp('last_used_at', { withTimezone: true }),
    createdAt: createdAt(),
  },
  (t) => [uniqueIndex('api_keys_hash_uq').on(t.keyHash)],
);

// ── People ─────────────────────────────────────────────────────────────────

/**
 * A person who signs in to the console. Keys are for machines; people have accounts. Never
 * deleted, so every user id recorded on an action still names someone.
 */
export const users = pgTable(
  'users',
  {
    id: id(),
    tenantId: uuid('tenant_id')
      .notNull()
      .references(() => tenants.id),
    /** Lowercased, unique within the tenant. */
    email: text('email').notNull(),
    name: text('name').notNull(),
    role: text('role', { enum: USER_ROLES }).notNull(),
    memberId: uuid('member_id').references(() => members.id),
    /** `scrypt$N$r$p$salt$hash`. Null until an invite is accepted. */
    passwordHash: text('password_hash'),
    /** AES-256-GCM under `NOVATE_SECRET_KEY`. Set at setup, in use once `totpEnabledAt` is. */
    totpSecret: text('totp_secret'),
    totpEnabledAt: timestamp('totp_enabled_at', { withTimezone: true }),
    /** The last step a code was accepted for, so no code works twice. */
    totpLastStep: bigint('totp_last_step', { mode: 'number' }),
    status: text('status', { enum: ['invited', 'active', 'disabled'] })
      .notNull()
      .default('invited'),
    createdAt: createdAt(),
    createdBy: jsonb('created_by').$type<ControlActor>().notNull(),
    lastLoginAt: timestamp('last_login_at', { withTimezone: true }),
    failedLogins: integer('failed_logins').notNull().default(0),
    lockedUntil: timestamp('locked_until', { withTimezone: true }),
  },
  (t) => [
    uniqueIndex('users_tenant_email_uq').on(t.tenantId, t.email),
    index('users_email_idx').on(t.email),
    check('users_email_lowercase', sql`${t.email} = lower(${t.email})`),
    check('users_member_role', sql`(${t.role} = 'member') = (${t.memberId} is not null)`),
  ],
);

/** A link that lets a person set their password. Only the token's hash is stored. */
export const userInvites = pgTable(
  'user_invites',
  {
    id: id(),
    tokenHash: text('token_hash').notNull(),
    userId: uuid('user_id')
      .notNull()
      .references(() => users.id),
    expiresAt: timestamp('expires_at', { withTimezone: true }).notNull(),
    usedAt: timestamp('used_at', { withTimezone: true }),
    createdBy: jsonb('created_by').$type<ControlActor>().notNull(),
    createdAt: createdAt(),
  },
  (t) => [
    uniqueIndex('user_invites_token_uq').on(t.tokenHash),
    index('user_invites_user_idx').on(t.userId),
  ],
);

/** Why a session was ended before it expired. */
export const SESSION_ENDS = [
  'signed_out',
  'password_changed',
  'user_disabled',
  'user_reset',
  'invite_accepted',
] as const;

/** A signed-in browser. The cookie holds the token; only its sha256 is stored. */
export const sessions = pgTable(
  'sessions',
  {
    idHash: text('id_hash').primaryKey(),
    userId: uuid('user_id')
      .notNull()
      .references(() => users.id),
    createdAt: createdAt(),
    /** Absolute: twelve hours after sign-in, however active. */
    expiresAt: timestamp('expires_at', { withTimezone: true }).notNull(),
    /** Idle timeout is measured from here. Moved forward at most once a minute. */
    lastSeenAt: timestamp('last_seen_at', { withTimezone: true }).notNull().defaultNow(),
    ip: text('ip'),
    userAgent: text('user_agent'),
    revokedAt: timestamp('revoked_at', { withTimezone: true }),
    /** Why it was revoked. Set exactly when `revokedAt` is. */
    endedReason: text('ended_reason', { enum: SESSION_ENDS }),
  },
  (t) => [
    index('sessions_user_idx').on(t.userId, t.createdAt.desc()),
    index('sessions_expires_idx').on(t.expiresAt),
    check('sessions_ended_reason', sql`(${t.revokedAt} is null) = (${t.endedReason} is null)`),
  ],
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
    /** When `railRefs` last changed, which for a provisioned member is when its accounts opened. */
    railRefsChangedAt: timestamp('rail_refs_changed_at', { withTimezone: true }),
    attributes: jsonb('attributes').$type<Record<string, unknown>>().notNull().default({}),
    /** Onboarding facts the platform keeps about the business. */
    legalName: text('legal_name'),
    /** ISO 3166-1 alpha-2. */
    country: text('country'),
    contactEmail: text('contact_email'),
    /**
     * The member's own four eyes: per currency, minor units as strings, a withdrawal its people ask
     * for above this waits for a second of its users. A currency not listed is never held.
     */
    withdrawalFourEyesAbove: jsonb('withdrawal_four_eyes_above')
      .$type<Record<string, string>>()
      .notNull()
      .default({}),
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
    mandate: jsonb('mandate').$type<StoredMandate>().notNull(),
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
    /** Who published this version. */
    createdBy: jsonb('created_by').$type<ControlActor>().notNull(),
    /** Why, in the publisher's words. */
    note: text('note'),
    createdAt: createdAt(),
  },
  (t) => [uniqueIndex('programs_key_version_uq').on(t.tenantId, t.key, t.version)],
);

// ── Control actions (append-only audit) ────────────────────────────────────

/** Every control action on a tenant, who took it and why. Never changed. */
export const controlEvents = pgTable(
  'control_events',
  {
    id: id(),
    tenantId: uuid('tenant_id')
      .notNull()
      .references(() => tenants.id),
    type: text('type', {
      enum: [
        'settlement_stopped',
        'settlement_resumed',
        'opening_recorded',
        'program_published',
        'agent_suspended',
        'agent_reinstated',
        'agent_mandate_changed',
        'case_assigned',
        'case_unassigned',
        'rail_refs_changed',
        'manual_credit',
        'deposit_assigned',
        'member_suspended',
        'member_reinstated',
        'member_close_only',
        'key_issued',
        'key_revoked',
        'break_resolved',
        'books_signed_off',
        'member_added',
        'agent_added',
        'user_invited',
        'user_disabled',
        'user_enabled',
        'user_login_locked',
        'user_reset',
        'invite_accepted',
        'user_signed_in',
        'two_step_enabled',
        'two_step_disabled',
        'password_changed',
        'withdrawal_requested',
        'default_fund_moved',
        'approval_requested',
        'approval_approved',
        'approval_rejected',
        'settings_changed',
        'member_updated',
        'provision_requested',
        'break_assigned',
        'break_unassigned',
        'payout_refreshed',
        'member_controls_changed',
      ],
    }).notNull(),
    actor: jsonb('actor').$type<ControlActor>().notNull(),
    reason: text('reason'),
    payload: jsonb('payload').$type<Record<string, unknown>>().notNull().default({}),
    createdAt: createdAt(),
  },
  (t) => [
    index('control_events_tenant_idx').on(t.tenantId, t.createdAt, t.id),
    index('control_events_type_idx').on(t.tenantId, t.type, t.createdAt),
    /** One sign-off per business day; a later one must name the one it supersedes. */
    uniqueIndex('control_events_sign_off_uq')
      .on(t.tenantId, sql`(${t.payload}->>'date')`)
      .where(sql`${t.type} = 'books_signed_off' and not (${t.payload} ? 'supersedes')`),
  ],
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
    terms: jsonb('terms').$type<StoredDealTerms>().notNull(),
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
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [
    uniqueIndex('deals_idempotency_uq').on(t.tenantId, t.idempotencyKey),
    index('deals_buyer_idx').on(t.buyerMemberId),
    index('deals_seller_idx').on(t.sellerMemberId),
    index('deals_tenant_created_idx').on(t.tenantId, t.createdAt, t.id),
    index('deals_buyer_agent_idx').on(t.buyerAgentId, t.currency, t.createdAt),
    index('deals_seller_agent_idx').on(t.sellerAgentId, t.currency, t.createdAt),
    check('deals_amount_positive', sql`${t.amount} > 0`),
  ],
);

/** Append-only audit trail of everything that happened to a deal. */
export const dealEvents = pgTable(
  'deal_events',
  {
    id: id(),
    /** The order events were written in within their transaction. */
    seq: bigserial('seq', { mode: 'bigint' }).notNull(),
    /**
     * The writing transaction. The feed reads in (xid, seq) order and only from transactions every
     * snapshot already sees as finished, so an event can never appear behind a reader's cursor.
     */
    xid: xid8('xid').notNull().default(sql`pg_current_xact_id()`),
    tenantId: uuid('tenant_id')
      .notNull()
      .references(() => tenants.id),
    dealId: uuid('deal_id')
      .notNull()
      .references(() => deals.id),
    type: text('type', {
      enum: [
        'authority_failed',
        'awaiting_conditions',
        'awaiting_funding',
        'cancelled',
        'card_funded',
        'card_refused',
        'check_rejected',
        'claim_closed',
        'claim_paid',
        'claim_filed',
        'claim_refunded',
        'conditions_evaluated',
        'confirmed',
        'cycle_failed',
        'deferred_by_decision',
        'deferred_by_default',
        'escrow_locked',
        'exception',
        'fact_added',
        'frozen',
        'held',
        'held_for_evidence',
        'locks_planned',
        'mandate_proof',
        'margin_call_failed',
        'margin_drawn',
        'margin_locked',
        'margin_resized',
        'netted',
        'policy_resolved',
        'refunded',
        'released',
        'repriced',
        'settled',
        'submitted',
        'verified',
        'waived',
        'x402_refused',
      ],
    }).notNull(),
    payload: jsonb('payload').$type<Record<string, unknown>>().notNull().default({}),
    createdAt: createdAt(),
  },
  (t) => [
    index('deal_events_deal_idx').on(t.dealId, t.createdAt),
    index('deal_events_feed_idx').on(t.tenantId, t.xid, t.seq),
    uniqueIndex('deal_events_seq_idx').on(t.seq),
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
    data: jsonb('data').$type<FactData>().notNull(),
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
    /** sha256 of `context` when the case opened, so the limits the gate used are bound too. */
    contextHash: text('context_hash').notNull(),
    status: text('status', { enum: ['open', 'decided', 'expired', 'stale'] })
      .notNull()
      .default('open'),
    resolution: jsonb('resolution').$type<CaseDecision>(),
    /** Too early to judge how this turned out. Look again after this. */
    judgeAfter: timestamp('judge_after', { withTimezone: true }),
    /** Who has taken the case, so two people do not work the same one. */
    assignee: jsonb('assignee').$type<ControlActor>(),
    assignedAt: timestamp('assigned_at', { withTimezone: true }),
    createdAt: createdAt(),
    closedAt: timestamp('closed_at', { withTimezone: true }),
  },
  (t) => [
    index('decision_cases_tenant_idx').on(t.tenantId, t.status),
    index('decision_cases_tenant_created_idx').on(t.tenantId, t.createdAt, t.id),
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
    action: jsonb('action').$type<StoredAction>().notNull(),
    rationale: text('rationale').notNull(),
    bindingHash: text('binding_hash').notNull(),
    accepted: integer('accepted').notNull(),
    /**
     * Every rule code applied to the proposal, passed or not, as `ActionCheck`. Refusals are the
     * failed ones. None when the decider never answered.
     */
    checks: jsonb('checks')
      .$type<
        {
          code: string;
          params?: Record<string, string>;
          passed: boolean;
          measure?: { amount: string; limit: string | null; currency: string };
        }[]
      >()
      .notNull(),
    metadata: jsonb('metadata').$type<RecordMetadata>().notNull().default({}),
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
    amount: money('amount').notNull(),
    currency: text('currency').notNull(),
    /** The two members of the deal, sorted, so one pair's successes can be capped. */
    pair: text('pair'),
    createdAt: createdAt(),
  },
  (t) => [index('decision_outcomes_tenant_kind_idx').on(t.tenantId, t.kind, t.createdAt)],
);

/** What a replay found, counted over the decisions it replayed. */
export interface ShadowSummary {
  replayed: number;
  same: number;
  changed: number;
  toPerson: number;
  /** The original went badly and the candidate would have done something else. */
  wouldHaveFixed: number;
  /** The original went well and the candidate would have done something else. */
  wouldHaveChanged: number;
}

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
    summary: jsonb('summary').$type<ShadowSummary>(),
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
    /** The failed checks of the candidate's last refused proposal, as `ActionCheck`. */
    refused: jsonb('refused')
      .$type<{ code: string; params?: Record<string, string>; passed: boolean }[]>()
      .notNull()
      .default([]),
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

export const CYCLE_KINDS = ['settlement', 'withdrawal'] as const;
export type CycleKind = (typeof CYCLE_KINDS)[number];

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
    /** A settlement cycle nets a settlement group; a withdrawal is a one-payment cycle. */
    kind: text('kind', { enum: CYCLE_KINDS }).notNull(),
    /** Set on a settlement cycle only. */
    settlementGroup: text('settlement_group'),
    summary: jsonb('summary').$type<Record<string, unknown>>(),
    /** Who asked for a withdrawal. Set on a withdrawal only. */
    requestedBy: jsonb('requested_by').$type<ControlActor>(),
    createdAt: createdAt(),
    closedAt: timestamp('closed_at', { withTimezone: true }),
  },
  (t) => [
    index('cycles_tenant_idx').on(t.tenantId, t.createdAt, t.id),
    check(
      'cycles_kind_shape',
      sql`(${t.kind} = 'settlement') = (${t.settlementGroup} IS NOT NULL) AND (${t.kind} = 'withdrawal') = (${t.requestedBy} IS NOT NULL)`,
    ),
  ],
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
    /** When a payout that could not be sent was credited back to the member's wallet. */
    returnedToWalletAt: timestamp('returned_to_wallet_at', { withTimezone: true }),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [
    uniqueIndex('settlement_instructions_idem_uq').on(t.idempotencyKey),
    index('settlement_instructions_cycle_idx').on(t.cycleId),
    // Rail events look an instruction up by ref alone; reconciliation adds the tenant.
    index('settlement_instructions_ref_idx').on(t.externalRef, t.tenantId),
    index('settlement_instructions_member_idx').on(t.tenantId, t.memberId, t.direction, t.status),
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
  (t) => [
    uniqueIndex('fx_conversions_idem_uq').on(t.idempotencyKey),
    index('fx_conversions_ref_idx').on(t.tenantId, t.externalRef),
  ],
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

/** What a reconciliation run recorded. Amounts are minor units, as strings. */
export type ReconRunSummary =
  /** What the account already held, per currency, that belongs to no member. */
  | { kind: 'opening'; balances: Record<string, string> }
  | {
      kind: 'comparison';
      transactions: number;
      /** Rail fees on known money, booked as house costs. */
      fees: number;
      /** Each currency as the ledger and the rail saw it, and what of it the opening holds. */
      positions: { currency: string; ledger: string; rail: string; atOpening: string }[];
    };

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
    /** Differences found. None for an opening. */
    breakCount: integer('break_count').notNull(),
    summary: jsonb('summary').$type<ReconRunSummary>().notNull(),
    createdAt: createdAt(),
  },
  (t) => [index('recon_runs_tenant_idx').on(t.tenantId, t.createdAt, t.id)],
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
    /** What the rail called the transaction, when the difference is one novate did not make. */
    detail: jsonb('detail')
      .$type<{ railType?: string; occurredAt?: string }>()
      .notNull()
      .default({}),
    createdAt: createdAt(),
  },
  (t) => [
    index('recon_breaks_run_idx').on(t.runId),
    index('recon_breaks_tenant_idx').on(t.tenantId, t.createdAt),
  ],
);

/** How a reconciliation break was closed, and by whom. A break with no row here is still open. */
export const reconBreakResolutions = pgTable(
  'recon_break_resolutions',
  {
    id: id(),
    breakId: uuid('break_id')
      .notNull()
      .references(() => reconBreaks.id),
    tenantId: uuid('tenant_id')
      .notNull()
      .references(() => tenants.id),
    resolution: text('resolution', {
      enum: ['posted', 'explained', 'written_off', 'opening_rebased'],
    }).notNull(),
    actor: jsonb('actor').$type<ControlActor>().notNull(),
    reason: text('reason').notNull(),
    /** What closed it: a ledger batch, a control event, a case. */
    reference: text('reference'),
    createdAt: createdAt(),
  },
  (t) => [
    uniqueIndex('recon_break_resolutions_break_uq').on(t.breakId),
    index('recon_break_resolutions_tenant_idx').on(t.tenantId, t.createdAt),
  ],
);

/**
 * Who owns a reconciliation break. Append-only: the latest row for a break says who holds it, and a
 * row with no assignee lets it go.
 */
export const reconBreakAssignments = pgTable(
  'recon_break_assignments',
  {
    id: id(),
    breakId: uuid('break_id')
      .notNull()
      .references(() => reconBreaks.id),
    tenantId: uuid('tenant_id')
      .notNull()
      .references(() => tenants.id),
    assignee: jsonb('assignee').$type<ControlActor>(),
    actor: jsonb('actor').$type<ControlActor>().notNull(),
    createdAt: createdAt(),
  },
  (t) => [index('recon_break_assignments_break_idx').on(t.breakId, t.createdAt)],
);

/**
 * An action held for a second person: a manual credit, a write-off, a person's case decision past
 * the program ceiling, a new rail opening, or a change of where a member is paid. What would run is kept here; the decision is its own
 * row, at most one per request, and the action runs in the same transaction as an approval.
 * Append-only.
 */
export const approvalRequests = pgTable(
  'approval_requests',
  {
    id: id(),
    tenantId: uuid('tenant_id')
      .notNull()
      .references(() => tenants.id),
    kind: text('kind', {
      enum: [
        'manual_credit',
        'break_write_off',
        'case_decision',
        'rail_opening',
        'rail_refs',
        'member_withdrawal',
        'member_controls',
      ],
    }).notNull(),
    /** Set when the request is a member's own, which only that member's users may decide. */
    memberId: uuid('member_id').references(() => members.id),
    actor: jsonb('actor').$type<ControlActor>().notNull(),
    /** The parsed input of the original action, replayed as is on approval. */
    payload: jsonb('payload').$type<Record<string, unknown>>().notNull(),
    /** What it moves or hides, when that is one amount. An opening holds its amounts in `payload`. */
    amount: money('amount'),
    currency: text('currency'),
    reason: text('reason').notNull(),
    createdAt: createdAt(),
  },
  (t) => [
    index('approval_requests_tenant_idx').on(t.tenantId, t.createdAt),
    index('approval_requests_member_idx').on(t.memberId, t.createdAt),
    check('approval_requests_amount', sql`(${t.amount} is null) = (${t.currency} is null)`),
  ],
);

export const approvalDecisions = pgTable(
  'approval_decisions',
  {
    id: id(),
    requestId: uuid('request_id')
      .notNull()
      .references(() => approvalRequests.id),
    tenantId: uuid('tenant_id')
      .notNull()
      .references(() => tenants.id),
    decision: text('decision', { enum: ['approved', 'rejected'] }).notNull(),
    actor: jsonb('actor').$type<ControlActor>().notNull(),
    reason: text('reason'),
    createdAt: createdAt(),
  },
  (t) => [uniqueIndex('approval_decisions_request_uq').on(t.requestId)],
);

/**
 * Every earlier version of a settlement instruction, conversion, rail event or tenant, written by
 * trigger whenever one is changed or removed, so what was paid and when cannot be rewritten without
 * trace. Append-only.
 */
export const rowHistory = pgTable(
  'row_history',
  {
    id: bigserial('id', { mode: 'bigint' }).primaryKey(),
    tableName: text('table_name').notNull(),
    rowId: text('row_id').notNull(),
    op: text('op', { enum: ['UPDATE', 'DELETE'] }).notNull(),
    old: jsonb('old').$type<Record<string, unknown>>().notNull(),
    /** The row after an update; null for a delete. */
    new: jsonb('new').$type<Record<string, unknown>>(),
    at: timestamp('at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [index('row_history_row_idx').on(t.tableName, t.rowId)],
);

// ── Ledger (double-entry, append-only) ─────────────────────────────────────

/**
 * What a ledger account is for. Together with its owner columns this is how readers find accounts;
 * the code is only the unique key.
 */
export const LEDGER_ACCOUNT_KINDS = [
  // A member's own: set `member_id`.
  'available',
  'debt',
  'default_fund',
  'portfolio_margin',
  // A member's position in one cycle: set `cycle_id` and `member_id`.
  'settlement',
  // Locked against one deal: set `deal_id`.
  'escrow',
  'margin',
  // The house's on one rail: set `rail`.
  'cash',
  'in_flight',
  'fees_paid',
  // The house's in one currency.
  'rail_fees',
  'house_fee_revenue',
  'platform_fee_revenue',
  'clearing',
  'fx',
  'suspense',
  'default_loss',
] as const;
export type LedgerAccountKind = (typeof LEDGER_ACCOUNT_KINDS)[number];

export const ledgerAccounts = pgTable(
  'ledger_accounts',
  {
    id: id(),
    tenantId: uuid('tenant_id')
      .notNull()
      .references(() => tenants.id),
    /** Stable human key, e.g. `member:<id>:EUR:available`, `deal:<id>:EUR:escrow`. */
    code: text('code').notNull(),
    kind: text('kind', { enum: LEDGER_ACCOUNT_KINDS }).notNull(),
    memberId: uuid('member_id'),
    dealId: uuid('deal_id'),
    cycleId: uuid('cycle_id'),
    rail: text('rail'),
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
    index('ledger_accounts_member_idx').on(t.tenantId, t.memberId),
    index('ledger_accounts_deal_idx').on(t.tenantId, t.dealId),
    index('ledger_accounts_cycle_idx').on(t.tenantId, t.cycleId),
    index('ledger_accounts_kind_idx').on(t.tenantId, t.kind),
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
    /** The settlement instruction this transfer carries out, if any. */
    instructionId: uuid('instruction_id').references(() => settlementInstructions.id),
    createdAt: createdAt(),
  },
  (t) => [
    uniqueIndex('ledger_transfers_idem_uq').on(t.tenantId, t.idempotencyKey),
    index('ledger_transfers_debit_idx').on(t.debitAccountId, t.createdAt, t.id),
    index('ledger_transfers_credit_idx').on(t.creditAccountId, t.createdAt, t.id),
    index('ledger_transfers_ref_idx').on(t.tenantId, t.ref),
    index('ledger_transfers_kind_idx').on(t.tenantId, t.kind, t.createdAt),
    check('ledger_transfers_amount_positive', sql`${t.amount} > 0`),
    check('ledger_transfers_distinct', sql`${t.debitAccountId} <> ${t.creditAccountId}`),
  ],
);
