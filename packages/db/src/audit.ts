import type pg from 'pg';

/**
 * How every table in the schema may change. Each table is in exactly one list, which decides both
 * its trigger (installed by `installAuditTriggers`) and what the application role may do to it
 * (`leastPrivilegeSql`).
 */

/**
 * The audit trail. Rows are only ever added: corrections are new rows, such as a resolution, a
 * reversing entry or a new program version. The application role may read and add to these, never
 * change or remove a row, so even a compromised server cannot rewrite history. Triggers refuse the
 * same for any role.
 */
export const AUDIT_TABLES = [
  'ledger_transfers',
  'deal_events',
  'deal_facts',
  'decision_records',
  'decision_outcomes',
  'control_events',
  'programs',
  'recon_runs',
  'recon_breaks',
  'recon_break_resolutions',
  'recon_break_assignments',
  'approval_requests',
  'approval_decisions',
  'row_history',
] as const;

/**
 * Rows that change status as money moves, so they may be updated, but never removed. Every change
 * leaves the row as it was, and what it became, in `row_history`. For `tenants` that is every
 * settlement stop, resume and settings change.
 */
export const HISTORIED_TABLES = [
  'settlement_instructions',
  'fx_conversions',
  'rail_events',
  'tenants',
] as const;

/**
 * People and the invites that let them in. They change status, so they may be updated, but never
 * removed: every user id on a recorded action must still name someone.
 */
export const NEVER_REMOVED_TABLES = ['users', 'user_invites'] as const;

/**
 * A case moves through its statuses, but what the decider was shown, its hash and the limits the
 * gate judges against are fixed when it opens. A case is never deleted.
 */
export const CASE_TABLE = 'decision_cases';

/** A case's columns that may change, and only these. */
export const CASE_COLUMNS = [
  'status',
  'resolution',
  'judge_after',
  'assignee',
  'assigned_at',
  'closed_at',
] as const;

/** Working state, changed and removed freely: sessions, balances, cursors, attempts and the like. */
export const MUTABLE_TABLES = [
  'agents',
  'api_keys',
  'api_rate_windows',
  'card_payments',
  'cycles',
  'deals',
  'fx_rate_samples',
  'instance_setup',
  'ledger_accounts',
  'margin_calls',
  'members',
  'obligations',
  'position_marks',
  'rail_cursors',
  'rail_outgoing_attempts',
  'sessions',
  'shadow_results',
  'shadow_runs',
  'unattributed_deposits',
  'x402_payments',
] as const;

const FUNCTIONS = [
  `CREATE OR REPLACE FUNCTION novate_reject_mutation() RETURNS trigger AS $$
   BEGIN
     RAISE EXCEPTION '% is append-only', TG_TABLE_NAME;
   END;
   $$ LANGUAGE plpgsql`,
  // TRUNCATE skips row triggers, so it is refused by a statement trigger of its own.
  `CREATE OR REPLACE FUNCTION novate_reject_truncate() RETURNS trigger AS $$
   BEGIN
     RAISE EXCEPTION '% cannot be truncated', TG_TABLE_NAME;
   END;
   $$ LANGUAGE plpgsql`,
  `CREATE OR REPLACE FUNCTION novate_reject_delete() RETURNS trigger AS $$
   BEGIN
     RAISE EXCEPTION '% rows are never removed', TG_TABLE_NAME;
   END;
   $$ LANGUAGE plpgsql`,
  `CREATE OR REPLACE FUNCTION novate_keep_history() RETURNS trigger AS $$
   BEGIN
     INSERT INTO row_history (table_name, row_id, op, old, new, at)
     VALUES (
       TG_TABLE_NAME,
       OLD.id::text,
       TG_OP,
       to_jsonb(OLD),
       CASE WHEN TG_OP = 'UPDATE' THEN to_jsonb(NEW) ELSE NULL END,
       clock_timestamp()
     );
     RETURN NULL;
   END;
   $$ LANGUAGE plpgsql`,
  `CREATE OR REPLACE FUNCTION novate_guard_decision_case() RETURNS trigger AS $$
   BEGIN
     IF TG_OP = 'DELETE' THEN
       RAISE EXCEPTION 'decision_cases are never deleted';
     END IF;
     IF NEW.shown IS DISTINCT FROM OLD.shown
        OR NEW.binding_hash IS DISTINCT FROM OLD.binding_hash
        OR NEW.context IS DISTINCT FROM OLD.context
        OR NEW.context_hash IS DISTINCT FROM OLD.context_hash THEN
       RAISE EXCEPTION 'what a decision case showed and judged against cannot change';
     END IF;
     RETURN NEW;
   END;
   $$ LANGUAGE plpgsql`,
  // A transfer must move money between two accounts of the same currency.
  `CREATE OR REPLACE FUNCTION novate_check_transfer_currency() RETURNS trigger AS $$
   BEGIN
     IF (SELECT currency FROM ledger_accounts WHERE id = NEW.debit_account_id) <> NEW.currency
        OR (SELECT currency FROM ledger_accounts WHERE id = NEW.credit_account_id) <> NEW.currency THEN
       RAISE EXCEPTION 'currency mismatch on transfer %', NEW.idempotency_key;
     END IF;
     RETURN NEW;
   END;
   $$ LANGUAGE plpgsql`,
];

/** One trigger: when it fires, on which table, and the function it runs. */
interface Trigger {
  name: string;
  table: string;
  when: string;
  each: 'ROW' | 'STATEMENT';
  run: string;
}

const noTruncate = (table: string): Trigger => ({
  name: `${table}_no_truncate`,
  table,
  when: 'BEFORE TRUNCATE',
  each: 'STATEMENT',
  run: 'novate_reject_truncate',
});

/** Every trigger the schema relies on, derived from the lists above. */
export const AUDIT_TRIGGERS: readonly Trigger[] = [
  ...AUDIT_TABLES.flatMap((table): Trigger[] => [
    {
      name: `${table}_append_only`,
      table,
      when: 'BEFORE UPDATE OR DELETE',
      each: 'ROW',
      run: 'novate_reject_mutation',
    },
    noTruncate(table),
  ]),
  ...HISTORIED_TABLES.flatMap((table): Trigger[] => [
    {
      name: `${table}_history`,
      table,
      when: 'AFTER UPDATE OR DELETE',
      each: 'ROW',
      run: 'novate_keep_history',
    },
    noTruncate(table),
  ]),
  ...NEVER_REMOVED_TABLES.flatMap((table): Trigger[] => [
    {
      name: `${table}_never_removed`,
      table,
      when: 'BEFORE DELETE',
      each: 'ROW',
      run: 'novate_reject_delete',
    },
    noTruncate(table),
  ]),
  {
    name: `${CASE_TABLE}_fixed_record`,
    table: CASE_TABLE,
    when: 'BEFORE UPDATE OR DELETE',
    each: 'ROW',
    run: 'novate_guard_decision_case',
  },
  noTruncate(CASE_TABLE),
  {
    name: 'ledger_transfers_currency',
    table: 'ledger_transfers',
    when: 'BEFORE INSERT',
    each: 'ROW',
    run: 'novate_check_transfer_currency',
  },
];

/** The functions and triggers, each trigger dropped and created again, so this can run on every boot. */
export function auditSql(): string[] {
  return [
    ...FUNCTIONS,
    ...AUDIT_TRIGGERS.flatMap((t) => [
      `DROP TRIGGER IF EXISTS ${t.name} ON ${t.table}`,
      `CREATE TRIGGER ${t.name} ${t.when} ON ${t.table} FOR EACH ${t.each} EXECUTE FUNCTION ${t.run}()`,
    ]),
  ];
}

/**
 * Install the audit functions and triggers, as the owner, in one transaction, so no write lands
 * while a trigger is missing. Runs after every migration: a table the migration added gets its
 * trigger from the lists above.
 */
export async function installAuditTriggers(client: pg.ClientBase): Promise<void> {
  await client.query('BEGIN');
  try {
    for (const statement of auditSql()) await client.query(statement);
    await client.query('COMMIT');
  } catch (err) {
    await client.query('ROLLBACK');
    throw err;
  }
}
