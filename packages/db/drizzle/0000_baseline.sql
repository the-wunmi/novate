CREATE TYPE "public"."deal_status" AS ENUM('submitted', 'authorised', 'frozen', 'awaiting_funding', 'awaiting_conditions', 'held', 'eligible', 'settling', 'settled', 'cancelled', 'rejected', 'refunded', 'exception');--> statement-breakpoint
CREATE TABLE "agents" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"tenant_id" uuid NOT NULL,
	"member_id" uuid NOT NULL,
	"name" text NOT NULL,
	"mandate" jsonb NOT NULL,
	"status" text DEFAULT 'active' NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "api_keys" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"tenant_id" uuid NOT NULL,
	"key_hash" text NOT NULL,
	"name" text NOT NULL,
	"principal" text NOT NULL,
	"member_id" uuid,
	"agent_id" uuid,
	"revoked_at" timestamp with time zone,
	"revoked_by" jsonb,
	"created_by" jsonb NOT NULL,
	"last_used_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "api_rate_windows" (
	"key_id" text NOT NULL,
	"window_start" timestamp with time zone NOT NULL,
	"requests" integer DEFAULT 1 NOT NULL
);
--> statement-breakpoint
CREATE TABLE "approval_decisions" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"request_id" uuid NOT NULL,
	"tenant_id" uuid NOT NULL,
	"decision" text NOT NULL,
	"actor" jsonb NOT NULL,
	"reason" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "approval_requests" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"tenant_id" uuid NOT NULL,
	"kind" text NOT NULL,
	"member_id" uuid,
	"actor" jsonb NOT NULL,
	"payload" jsonb NOT NULL,
	"amount" bigint,
	"currency" text,
	"reason" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "approval_requests_amount" CHECK (("approval_requests"."amount" is null) = ("approval_requests"."currency" is null))
);
--> statement-breakpoint
CREATE TABLE "card_payments" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"tenant_id" uuid NOT NULL,
	"deal_id" uuid NOT NULL,
	"member_id" uuid NOT NULL,
	"rail" text NOT NULL,
	"mandate_id" text NOT NULL,
	"amount" bigint NOT NULL,
	"currency" text NOT NULL,
	"status" text DEFAULT 'open' NOT NULL,
	"intent_id" text,
	"attempt_ref" text,
	"reason" text,
	"settled_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "control_events" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"tenant_id" uuid NOT NULL,
	"type" text NOT NULL,
	"actor" jsonb NOT NULL,
	"reason" text,
	"payload" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "cycles" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"tenant_id" uuid NOT NULL,
	"status" text DEFAULT 'netting' NOT NULL,
	"kind" text NOT NULL,
	"settlement_group" text,
	"summary" jsonb,
	"requested_by" jsonb,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"closed_at" timestamp with time zone,
	CONSTRAINT "cycles_kind_shape" CHECK (("cycles"."kind" = 'settlement') = ("cycles"."settlement_group" IS NOT NULL) AND ("cycles"."kind" = 'withdrawal') = ("cycles"."requested_by" IS NOT NULL))
);
--> statement-breakpoint
CREATE TABLE "deal_events" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"seq" bigserial NOT NULL,
	"xid" "xid8" DEFAULT pg_current_xact_id() NOT NULL,
	"tenant_id" uuid NOT NULL,
	"deal_id" uuid NOT NULL,
	"type" text NOT NULL,
	"payload" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "deal_facts" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"deal_id" uuid NOT NULL,
	"kind" text NOT NULL,
	"type" text NOT NULL,
	"source" text NOT NULL,
	"data" jsonb NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "deals" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"tenant_id" uuid NOT NULL,
	"idempotency_key" text NOT NULL,
	"program_id" uuid NOT NULL,
	"buyer_member_id" uuid NOT NULL,
	"seller_member_id" uuid NOT NULL,
	"buyer_agent_id" uuid,
	"seller_agent_id" uuid,
	"currency" text NOT NULL,
	"amount" bigint NOT NULL,
	"quantity" integer NOT NULL,
	"terms" jsonb NOT NULL,
	"status" "deal_status" DEFAULT 'submitted' NOT NULL,
	"policy_snapshot" jsonb,
	"release_amount" bigint,
	"terms_hash" text,
	"awaiting_side" text,
	"authority_passed_at" timestamp with time zone,
	"funding_currency" text,
	"margin_currency" text,
	"status_reason" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "deals_amount_positive" CHECK ("deals"."amount" > 0)
);
--> statement-breakpoint
CREATE TABLE "decision_cases" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"tenant_id" uuid NOT NULL,
	"kind" text NOT NULL,
	"subject_type" text NOT NULL,
	"subject_id" text NOT NULL,
	"deal_id" uuid,
	"reason" text NOT NULL,
	"binding_hash" text NOT NULL,
	"shown" jsonb NOT NULL,
	"context" jsonb NOT NULL,
	"context_hash" text NOT NULL,
	"status" text DEFAULT 'open' NOT NULL,
	"resolution" jsonb,
	"judge_after" timestamp with time zone,
	"assignee" jsonb,
	"assigned_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"closed_at" timestamp with time zone
);
--> statement-breakpoint
CREATE TABLE "decision_outcomes" (
	"case_id" uuid PRIMARY KEY NOT NULL,
	"tenant_id" uuid NOT NULL,
	"kind" text NOT NULL,
	"action_type" text NOT NULL,
	"verdict" text NOT NULL,
	"signals" jsonb NOT NULL,
	"program_key" text,
	"amount" bigint NOT NULL,
	"currency" text NOT NULL,
	"pair" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "decision_records" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"case_id" uuid NOT NULL,
	"decider_type" text NOT NULL,
	"decider_id" text NOT NULL,
	"action" jsonb NOT NULL,
	"rationale" text NOT NULL,
	"binding_hash" text NOT NULL,
	"accepted" integer NOT NULL,
	"checks" jsonb NOT NULL,
	"metadata" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "fx_conversions" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"tenant_id" uuid NOT NULL,
	"cycle_id" uuid NOT NULL,
	"rail" text NOT NULL,
	"sell_currency" text NOT NULL,
	"buy_currency" text NOT NULL,
	"sell_amount" bigint NOT NULL,
	"buy_amount" bigint NOT NULL,
	"rate_e8" bigint NOT NULL,
	"status" text DEFAULT 'submitted' NOT NULL,
	"external_ref" text,
	"idempotency_key" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "fx_rate_samples" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"sell_currency" text NOT NULL,
	"buy_currency" text NOT NULL,
	"rate_e8" bigint NOT NULL,
	"sampled_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "instance_setup" (
	"id" boolean PRIMARY KEY DEFAULT true NOT NULL,
	"default_tenant_id" uuid NOT NULL,
	"operator_key_hash" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "ledger_accounts" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"tenant_id" uuid NOT NULL,
	"code" text NOT NULL,
	"kind" text NOT NULL,
	"member_id" uuid,
	"deal_id" uuid,
	"cycle_id" uuid,
	"rail" text,
	"currency" text NOT NULL,
	"normal" text NOT NULL,
	"no_overdraft" integer DEFAULT 1 NOT NULL,
	"debits_posted" bigint DEFAULT 0 NOT NULL,
	"credits_posted" bigint DEFAULT 0 NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "ledger_accounts_overdraft" CHECK ("ledger_accounts"."no_overdraft" = 0 OR (CASE WHEN "ledger_accounts"."normal" = 'credit' THEN "ledger_accounts"."credits_posted" - "ledger_accounts"."debits_posted" ELSE "ledger_accounts"."debits_posted" - "ledger_accounts"."credits_posted" END) >= 0)
);
--> statement-breakpoint
CREATE TABLE "ledger_transfers" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"tenant_id" uuid NOT NULL,
	"batch_id" uuid NOT NULL,
	"idempotency_key" text NOT NULL,
	"debit_account_id" uuid NOT NULL,
	"credit_account_id" uuid NOT NULL,
	"currency" text NOT NULL,
	"amount" bigint NOT NULL,
	"kind" text NOT NULL,
	"ref" text,
	"instruction_id" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "ledger_transfers_amount_positive" CHECK ("ledger_transfers"."amount" > 0),
	CONSTRAINT "ledger_transfers_distinct" CHECK ("ledger_transfers"."debit_account_id" <> "ledger_transfers"."credit_account_id")
);
--> statement-breakpoint
CREATE TABLE "margin_calls" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"tenant_id" uuid NOT NULL,
	"member_id" uuid NOT NULL,
	"currency" text NOT NULL,
	"amount" bigint NOT NULL,
	"status" text DEFAULT 'open' NOT NULL,
	"due_at" timestamp with time zone NOT NULL,
	"extensions" integer DEFAULT 0 NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"closed_at" timestamp with time zone
);
--> statement-breakpoint
CREATE TABLE "members" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"tenant_id" uuid NOT NULL,
	"name" text NOT NULL,
	"home_currency" text NOT NULL,
	"status" text DEFAULT 'active' NOT NULL,
	"rail_refs" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"rail_refs_changed_at" timestamp with time zone,
	"attributes" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"legal_name" text,
	"country" text,
	"contact_email" text,
	"withdrawal_four_eyes_above" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "obligations" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"tenant_id" uuid NOT NULL,
	"deal_id" uuid NOT NULL,
	"payer_member_id" uuid NOT NULL,
	"payee_member_id" uuid NOT NULL,
	"currency" text NOT NULL,
	"amount" bigint NOT NULL,
	"leg" text DEFAULT 'principal' NOT NULL,
	"settlement_group" text,
	"status" text DEFAULT 'pending' NOT NULL,
	"cycle_id" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "position_marks" (
	"deal_id" uuid NOT NULL,
	"member_id" uuid NOT NULL,
	"rate_e8" bigint NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "programs" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"tenant_id" uuid NOT NULL,
	"key" text NOT NULL,
	"version" integer NOT NULL,
	"spec" jsonb NOT NULL,
	"created_by" jsonb NOT NULL,
	"note" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "rail_cursors" (
	"rail" text PRIMARY KEY NOT NULL,
	"position" bigint NOT NULL
);
--> statement-breakpoint
CREATE TABLE "rail_events" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"rail" text NOT NULL,
	"external_id" text NOT NULL,
	"type" text NOT NULL,
	"payload" jsonb NOT NULL,
	"occurred_at" timestamp with time zone NOT NULL,
	"processed_at" timestamp with time zone,
	"outcome" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "rail_outgoing_attempts" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"rail" text NOT NULL,
	"idempotency_key" text NOT NULL,
	"tx_hash" text NOT NULL,
	"nonce" bigint NOT NULL,
	"raw" text NOT NULL,
	"recipient" text NOT NULL,
	"value" numeric(78, 0) NOT NULL,
	"fee" numeric(78, 0),
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "recon_break_assignments" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"break_id" uuid NOT NULL,
	"tenant_id" uuid NOT NULL,
	"assignee" jsonb,
	"actor" jsonb NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "recon_break_resolutions" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"break_id" uuid NOT NULL,
	"tenant_id" uuid NOT NULL,
	"resolution" text NOT NULL,
	"actor" jsonb NOT NULL,
	"reason" text NOT NULL,
	"reference" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "recon_breaks" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"run_id" uuid NOT NULL,
	"tenant_id" uuid NOT NULL,
	"kind" text NOT NULL,
	"currency" text NOT NULL,
	"expected" bigint NOT NULL,
	"actual" bigint NOT NULL,
	"external_ref" text,
	"detail" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "recon_runs" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"tenant_id" uuid NOT NULL,
	"rail" text NOT NULL,
	"status" text NOT NULL,
	"break_count" integer NOT NULL,
	"summary" jsonb NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "row_history" (
	"id" bigserial PRIMARY KEY NOT NULL,
	"table_name" text NOT NULL,
	"row_id" text NOT NULL,
	"op" text NOT NULL,
	"old" jsonb NOT NULL,
	"new" jsonb,
	"at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "sessions" (
	"id_hash" text PRIMARY KEY NOT NULL,
	"user_id" uuid NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"expires_at" timestamp with time zone NOT NULL,
	"last_seen_at" timestamp with time zone DEFAULT now() NOT NULL,
	"ip" text,
	"user_agent" text,
	"revoked_at" timestamp with time zone,
	"ended_reason" text,
	CONSTRAINT "sessions_ended_reason" CHECK (("sessions"."revoked_at" is null) = ("sessions"."ended_reason" is null))
);
--> statement-breakpoint
CREATE TABLE "settlement_instructions" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"tenant_id" uuid NOT NULL,
	"cycle_id" uuid NOT NULL,
	"member_id" uuid NOT NULL,
	"direction" text NOT NULL,
	"currency" text NOT NULL,
	"amount" bigint NOT NULL,
	"rail" text NOT NULL,
	"status" text DEFAULT 'pending' NOT NULL,
	"attempt" integer DEFAULT 0 NOT NULL,
	"external_ref" text,
	"idempotency_key" text NOT NULL,
	"failure_reason" text,
	"returned_to_wallet_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "settlement_instructions_amount_positive" CHECK ("settlement_instructions"."amount" > 0)
);
--> statement-breakpoint
CREATE TABLE "shadow_results" (
	"run_id" uuid NOT NULL,
	"case_id" uuid NOT NULL,
	"recorded" text NOT NULL,
	"candidate" text NOT NULL,
	"rationale" text,
	"verdict" text,
	"refused" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "shadow_runs" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"tenant_id" uuid NOT NULL,
	"status" text DEFAULT 'running' NOT NULL,
	"candidate" jsonb NOT NULL,
	"summary" jsonb,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"finished_at" timestamp with time zone
);
--> statement-breakpoint
CREATE TABLE "tenants" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"name" text NOT NULL,
	"settlement_halted_at" timestamp with time zone,
	"settlement_halt_reason" text,
	"settings" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "unattributed_deposits" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"tenant_id" uuid NOT NULL,
	"rail" text NOT NULL,
	"external_ref" text NOT NULL,
	"deposit_account_ref" text NOT NULL,
	"currency" text NOT NULL,
	"amount" bigint NOT NULL,
	"status" text DEFAULT 'open' NOT NULL,
	"member_id" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "user_invites" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"token_hash" text NOT NULL,
	"user_id" uuid NOT NULL,
	"expires_at" timestamp with time zone NOT NULL,
	"used_at" timestamp with time zone,
	"created_by" jsonb NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "users" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"tenant_id" uuid NOT NULL,
	"email" text NOT NULL,
	"name" text NOT NULL,
	"role" text NOT NULL,
	"member_id" uuid,
	"password_hash" text,
	"totp_secret" text,
	"totp_enabled_at" timestamp with time zone,
	"totp_last_step" bigint,
	"status" text DEFAULT 'invited' NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"created_by" jsonb NOT NULL,
	"last_login_at" timestamp with time zone,
	"failed_logins" integer DEFAULT 0 NOT NULL,
	"locked_until" timestamp with time zone,
	CONSTRAINT "users_email_lowercase" CHECK ("users"."email" = lower("users"."email")),
	CONSTRAINT "users_member_role" CHECK (("users"."role" = 'member') = ("users"."member_id" is not null))
);
--> statement-breakpoint
CREATE TABLE "x402_payments" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"tenant_id" uuid NOT NULL,
	"deal_id" uuid NOT NULL,
	"member_id" uuid NOT NULL,
	"rail" text NOT NULL,
	"payer" text NOT NULL,
	"amount" bigint NOT NULL,
	"signature_hash" text NOT NULL,
	"status" text DEFAULT 'pending' NOT NULL,
	"tx_hash" text,
	"claimed_ref" text,
	"reason" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "agents" ADD CONSTRAINT "agents_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "agents" ADD CONSTRAINT "agents_member_id_members_id_fk" FOREIGN KEY ("member_id") REFERENCES "public"."members"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "api_keys" ADD CONSTRAINT "api_keys_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "api_keys" ADD CONSTRAINT "api_keys_member_id_members_id_fk" FOREIGN KEY ("member_id") REFERENCES "public"."members"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "api_keys" ADD CONSTRAINT "api_keys_agent_id_agents_id_fk" FOREIGN KEY ("agent_id") REFERENCES "public"."agents"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "approval_decisions" ADD CONSTRAINT "approval_decisions_request_id_approval_requests_id_fk" FOREIGN KEY ("request_id") REFERENCES "public"."approval_requests"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "approval_decisions" ADD CONSTRAINT "approval_decisions_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "approval_requests" ADD CONSTRAINT "approval_requests_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "approval_requests" ADD CONSTRAINT "approval_requests_member_id_members_id_fk" FOREIGN KEY ("member_id") REFERENCES "public"."members"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "card_payments" ADD CONSTRAINT "card_payments_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "card_payments" ADD CONSTRAINT "card_payments_deal_id_deals_id_fk" FOREIGN KEY ("deal_id") REFERENCES "public"."deals"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "card_payments" ADD CONSTRAINT "card_payments_member_id_members_id_fk" FOREIGN KEY ("member_id") REFERENCES "public"."members"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "control_events" ADD CONSTRAINT "control_events_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "cycles" ADD CONSTRAINT "cycles_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "deal_events" ADD CONSTRAINT "deal_events_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "deal_events" ADD CONSTRAINT "deal_events_deal_id_deals_id_fk" FOREIGN KEY ("deal_id") REFERENCES "public"."deals"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "deal_facts" ADD CONSTRAINT "deal_facts_deal_id_deals_id_fk" FOREIGN KEY ("deal_id") REFERENCES "public"."deals"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "deals" ADD CONSTRAINT "deals_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "deals" ADD CONSTRAINT "deals_program_id_programs_id_fk" FOREIGN KEY ("program_id") REFERENCES "public"."programs"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "deals" ADD CONSTRAINT "deals_buyer_member_id_members_id_fk" FOREIGN KEY ("buyer_member_id") REFERENCES "public"."members"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "deals" ADD CONSTRAINT "deals_seller_member_id_members_id_fk" FOREIGN KEY ("seller_member_id") REFERENCES "public"."members"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "deals" ADD CONSTRAINT "deals_buyer_agent_id_agents_id_fk" FOREIGN KEY ("buyer_agent_id") REFERENCES "public"."agents"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "deals" ADD CONSTRAINT "deals_seller_agent_id_agents_id_fk" FOREIGN KEY ("seller_agent_id") REFERENCES "public"."agents"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "decision_cases" ADD CONSTRAINT "decision_cases_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "decision_cases" ADD CONSTRAINT "decision_cases_deal_id_deals_id_fk" FOREIGN KEY ("deal_id") REFERENCES "public"."deals"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "decision_outcomes" ADD CONSTRAINT "decision_outcomes_case_id_decision_cases_id_fk" FOREIGN KEY ("case_id") REFERENCES "public"."decision_cases"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "decision_outcomes" ADD CONSTRAINT "decision_outcomes_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "decision_records" ADD CONSTRAINT "decision_records_case_id_decision_cases_id_fk" FOREIGN KEY ("case_id") REFERENCES "public"."decision_cases"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "fx_conversions" ADD CONSTRAINT "fx_conversions_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "fx_conversions" ADD CONSTRAINT "fx_conversions_cycle_id_cycles_id_fk" FOREIGN KEY ("cycle_id") REFERENCES "public"."cycles"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "instance_setup" ADD CONSTRAINT "instance_setup_default_tenant_id_tenants_id_fk" FOREIGN KEY ("default_tenant_id") REFERENCES "public"."tenants"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "ledger_accounts" ADD CONSTRAINT "ledger_accounts_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "ledger_transfers" ADD CONSTRAINT "ledger_transfers_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "ledger_transfers" ADD CONSTRAINT "ledger_transfers_debit_account_id_ledger_accounts_id_fk" FOREIGN KEY ("debit_account_id") REFERENCES "public"."ledger_accounts"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "ledger_transfers" ADD CONSTRAINT "ledger_transfers_credit_account_id_ledger_accounts_id_fk" FOREIGN KEY ("credit_account_id") REFERENCES "public"."ledger_accounts"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "ledger_transfers" ADD CONSTRAINT "ledger_transfers_instruction_id_settlement_instructions_id_fk" FOREIGN KEY ("instruction_id") REFERENCES "public"."settlement_instructions"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "margin_calls" ADD CONSTRAINT "margin_calls_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "margin_calls" ADD CONSTRAINT "margin_calls_member_id_members_id_fk" FOREIGN KEY ("member_id") REFERENCES "public"."members"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "members" ADD CONSTRAINT "members_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "obligations" ADD CONSTRAINT "obligations_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "obligations" ADD CONSTRAINT "obligations_deal_id_deals_id_fk" FOREIGN KEY ("deal_id") REFERENCES "public"."deals"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "obligations" ADD CONSTRAINT "obligations_payer_member_id_members_id_fk" FOREIGN KEY ("payer_member_id") REFERENCES "public"."members"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "obligations" ADD CONSTRAINT "obligations_payee_member_id_members_id_fk" FOREIGN KEY ("payee_member_id") REFERENCES "public"."members"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "position_marks" ADD CONSTRAINT "position_marks_deal_id_deals_id_fk" FOREIGN KEY ("deal_id") REFERENCES "public"."deals"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "position_marks" ADD CONSTRAINT "position_marks_member_id_members_id_fk" FOREIGN KEY ("member_id") REFERENCES "public"."members"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "programs" ADD CONSTRAINT "programs_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "recon_break_assignments" ADD CONSTRAINT "recon_break_assignments_break_id_recon_breaks_id_fk" FOREIGN KEY ("break_id") REFERENCES "public"."recon_breaks"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "recon_break_assignments" ADD CONSTRAINT "recon_break_assignments_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "recon_break_resolutions" ADD CONSTRAINT "recon_break_resolutions_break_id_recon_breaks_id_fk" FOREIGN KEY ("break_id") REFERENCES "public"."recon_breaks"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "recon_break_resolutions" ADD CONSTRAINT "recon_break_resolutions_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "recon_breaks" ADD CONSTRAINT "recon_breaks_run_id_recon_runs_id_fk" FOREIGN KEY ("run_id") REFERENCES "public"."recon_runs"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "recon_breaks" ADD CONSTRAINT "recon_breaks_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "recon_runs" ADD CONSTRAINT "recon_runs_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "sessions" ADD CONSTRAINT "sessions_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "settlement_instructions" ADD CONSTRAINT "settlement_instructions_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "settlement_instructions" ADD CONSTRAINT "settlement_instructions_cycle_id_cycles_id_fk" FOREIGN KEY ("cycle_id") REFERENCES "public"."cycles"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "settlement_instructions" ADD CONSTRAINT "settlement_instructions_member_id_members_id_fk" FOREIGN KEY ("member_id") REFERENCES "public"."members"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "shadow_results" ADD CONSTRAINT "shadow_results_run_id_shadow_runs_id_fk" FOREIGN KEY ("run_id") REFERENCES "public"."shadow_runs"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "shadow_results" ADD CONSTRAINT "shadow_results_case_id_decision_cases_id_fk" FOREIGN KEY ("case_id") REFERENCES "public"."decision_cases"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "shadow_runs" ADD CONSTRAINT "shadow_runs_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "unattributed_deposits" ADD CONSTRAINT "unattributed_deposits_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "unattributed_deposits" ADD CONSTRAINT "unattributed_deposits_member_id_members_id_fk" FOREIGN KEY ("member_id") REFERENCES "public"."members"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "user_invites" ADD CONSTRAINT "user_invites_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "users" ADD CONSTRAINT "users_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "users" ADD CONSTRAINT "users_member_id_members_id_fk" FOREIGN KEY ("member_id") REFERENCES "public"."members"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "x402_payments" ADD CONSTRAINT "x402_payments_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "x402_payments" ADD CONSTRAINT "x402_payments_deal_id_deals_id_fk" FOREIGN KEY ("deal_id") REFERENCES "public"."deals"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "x402_payments" ADD CONSTRAINT "x402_payments_member_id_members_id_fk" FOREIGN KEY ("member_id") REFERENCES "public"."members"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "agents_member_idx" ON "agents" USING btree ("member_id");--> statement-breakpoint
CREATE UNIQUE INDEX "api_keys_hash_uq" ON "api_keys" USING btree ("key_hash");--> statement-breakpoint
CREATE UNIQUE INDEX "api_rate_windows_uq" ON "api_rate_windows" USING btree ("key_id","window_start");--> statement-breakpoint
CREATE UNIQUE INDEX "approval_decisions_request_uq" ON "approval_decisions" USING btree ("request_id");--> statement-breakpoint
CREATE INDEX "approval_requests_tenant_idx" ON "approval_requests" USING btree ("tenant_id","created_at");--> statement-breakpoint
CREATE INDEX "approval_requests_member_idx" ON "approval_requests" USING btree ("member_id","created_at");--> statement-breakpoint
CREATE UNIQUE INDEX "card_payments_mandate_uq" ON "card_payments" USING btree ("mandate_id");--> statement-breakpoint
CREATE UNIQUE INDEX "card_payments_one_open_uq" ON "card_payments" USING btree ("deal_id") WHERE "card_payments"."status" = 'open';--> statement-breakpoint
CREATE INDEX "card_payments_intent_idx" ON "card_payments" USING btree ("intent_id");--> statement-breakpoint
CREATE INDEX "card_payments_tenant_status_idx" ON "card_payments" USING btree ("tenant_id","status");--> statement-breakpoint
CREATE INDEX "card_payments_attempt_ref_idx" ON "card_payments" USING btree ("attempt_ref");--> statement-breakpoint
CREATE INDEX "control_events_tenant_idx" ON "control_events" USING btree ("tenant_id","created_at","id");--> statement-breakpoint
CREATE INDEX "control_events_type_idx" ON "control_events" USING btree ("tenant_id","type","created_at");--> statement-breakpoint
CREATE UNIQUE INDEX "control_events_sign_off_uq" ON "control_events" USING btree ("tenant_id",("payload"->>'date')) WHERE "control_events"."type" = 'books_signed_off' and not ("control_events"."payload" ? 'supersedes');--> statement-breakpoint
CREATE INDEX "cycles_tenant_idx" ON "cycles" USING btree ("tenant_id","created_at","id");--> statement-breakpoint
CREATE INDEX "deal_events_deal_idx" ON "deal_events" USING btree ("deal_id","created_at");--> statement-breakpoint
CREATE INDEX "deal_events_feed_idx" ON "deal_events" USING btree ("tenant_id","xid","seq");--> statement-breakpoint
CREATE UNIQUE INDEX "deal_events_seq_idx" ON "deal_events" USING btree ("seq");--> statement-breakpoint
CREATE INDEX "deal_facts_deal_idx" ON "deal_facts" USING btree ("deal_id");--> statement-breakpoint
CREATE UNIQUE INDEX "deals_idempotency_uq" ON "deals" USING btree ("tenant_id","idempotency_key");--> statement-breakpoint
CREATE INDEX "deals_buyer_idx" ON "deals" USING btree ("buyer_member_id");--> statement-breakpoint
CREATE INDEX "deals_seller_idx" ON "deals" USING btree ("seller_member_id");--> statement-breakpoint
CREATE INDEX "deals_tenant_created_idx" ON "deals" USING btree ("tenant_id","created_at","id");--> statement-breakpoint
CREATE INDEX "deals_buyer_agent_idx" ON "deals" USING btree ("buyer_agent_id","currency","created_at");--> statement-breakpoint
CREATE INDEX "deals_seller_agent_idx" ON "deals" USING btree ("seller_agent_id","currency","created_at");--> statement-breakpoint
CREATE INDEX "decision_cases_tenant_idx" ON "decision_cases" USING btree ("tenant_id","status");--> statement-breakpoint
CREATE INDEX "decision_cases_tenant_created_idx" ON "decision_cases" USING btree ("tenant_id","created_at","id");--> statement-breakpoint
CREATE INDEX "decision_cases_deal_idx" ON "decision_cases" USING btree ("deal_id");--> statement-breakpoint
CREATE INDEX "decision_outcomes_tenant_kind_idx" ON "decision_outcomes" USING btree ("tenant_id","kind","created_at");--> statement-breakpoint
CREATE INDEX "decision_records_case_idx" ON "decision_records" USING btree ("case_id");--> statement-breakpoint
CREATE UNIQUE INDEX "fx_conversions_idem_uq" ON "fx_conversions" USING btree ("idempotency_key");--> statement-breakpoint
CREATE INDEX "fx_conversions_ref_idx" ON "fx_conversions" USING btree ("tenant_id","external_ref");--> statement-breakpoint
CREATE INDEX "fx_rate_samples_pair_idx" ON "fx_rate_samples" USING btree ("sell_currency","buy_currency","sampled_at");--> statement-breakpoint
CREATE UNIQUE INDEX "ledger_accounts_code_uq" ON "ledger_accounts" USING btree ("tenant_id","code");--> statement-breakpoint
CREATE INDEX "ledger_accounts_member_idx" ON "ledger_accounts" USING btree ("tenant_id","member_id");--> statement-breakpoint
CREATE INDEX "ledger_accounts_deal_idx" ON "ledger_accounts" USING btree ("tenant_id","deal_id");--> statement-breakpoint
CREATE INDEX "ledger_accounts_cycle_idx" ON "ledger_accounts" USING btree ("tenant_id","cycle_id");--> statement-breakpoint
CREATE INDEX "ledger_accounts_kind_idx" ON "ledger_accounts" USING btree ("tenant_id","kind");--> statement-breakpoint
CREATE UNIQUE INDEX "ledger_transfers_idem_uq" ON "ledger_transfers" USING btree ("tenant_id","idempotency_key");--> statement-breakpoint
CREATE INDEX "ledger_transfers_debit_idx" ON "ledger_transfers" USING btree ("debit_account_id","created_at","id");--> statement-breakpoint
CREATE INDEX "ledger_transfers_credit_idx" ON "ledger_transfers" USING btree ("credit_account_id","created_at","id");--> statement-breakpoint
CREATE INDEX "ledger_transfers_ref_idx" ON "ledger_transfers" USING btree ("tenant_id","ref");--> statement-breakpoint
CREATE INDEX "ledger_transfers_kind_idx" ON "ledger_transfers" USING btree ("tenant_id","kind","created_at");--> statement-breakpoint
CREATE UNIQUE INDEX "margin_calls_one_open_uq" ON "margin_calls" USING btree ("member_id") WHERE "margin_calls"."status" = 'open';--> statement-breakpoint
CREATE INDEX "margin_calls_tenant_status_idx" ON "margin_calls" USING btree ("tenant_id","status");--> statement-breakpoint
CREATE INDEX "members_tenant_idx" ON "members" USING btree ("tenant_id");--> statement-breakpoint
CREATE UNIQUE INDEX "obligations_deal_leg_uq" ON "obligations" USING btree ("deal_id","leg");--> statement-breakpoint
CREATE INDEX "obligations_eligible_idx" ON "obligations" USING btree ("tenant_id","status");--> statement-breakpoint
CREATE UNIQUE INDEX "position_marks_deal_member_uq" ON "position_marks" USING btree ("deal_id","member_id");--> statement-breakpoint
CREATE UNIQUE INDEX "programs_key_version_uq" ON "programs" USING btree ("tenant_id","key","version");--> statement-breakpoint
CREATE UNIQUE INDEX "rail_events_external_uq" ON "rail_events" USING btree ("rail","external_id");--> statement-breakpoint
CREATE UNIQUE INDEX "rail_outgoing_key_uq" ON "rail_outgoing_attempts" USING btree ("rail","idempotency_key");--> statement-breakpoint
CREATE UNIQUE INDEX "rail_outgoing_hash_uq" ON "rail_outgoing_attempts" USING btree ("rail","tx_hash");--> statement-breakpoint
CREATE UNIQUE INDEX "rail_outgoing_nonce_uq" ON "rail_outgoing_attempts" USING btree ("rail","nonce");--> statement-breakpoint
CREATE INDEX "recon_break_assignments_break_idx" ON "recon_break_assignments" USING btree ("break_id","created_at");--> statement-breakpoint
CREATE UNIQUE INDEX "recon_break_resolutions_break_uq" ON "recon_break_resolutions" USING btree ("break_id");--> statement-breakpoint
CREATE INDEX "recon_break_resolutions_tenant_idx" ON "recon_break_resolutions" USING btree ("tenant_id","created_at");--> statement-breakpoint
CREATE INDEX "recon_breaks_run_idx" ON "recon_breaks" USING btree ("run_id");--> statement-breakpoint
CREATE INDEX "recon_breaks_tenant_idx" ON "recon_breaks" USING btree ("tenant_id","created_at");--> statement-breakpoint
CREATE INDEX "recon_runs_tenant_idx" ON "recon_runs" USING btree ("tenant_id","created_at","id");--> statement-breakpoint
CREATE INDEX "row_history_row_idx" ON "row_history" USING btree ("table_name","row_id");--> statement-breakpoint
CREATE INDEX "sessions_user_idx" ON "sessions" USING btree ("user_id","created_at" DESC NULLS LAST);--> statement-breakpoint
CREATE INDEX "sessions_expires_idx" ON "sessions" USING btree ("expires_at");--> statement-breakpoint
CREATE UNIQUE INDEX "settlement_instructions_idem_uq" ON "settlement_instructions" USING btree ("idempotency_key");--> statement-breakpoint
CREATE INDEX "settlement_instructions_cycle_idx" ON "settlement_instructions" USING btree ("cycle_id");--> statement-breakpoint
CREATE INDEX "settlement_instructions_ref_idx" ON "settlement_instructions" USING btree ("external_ref","tenant_id");--> statement-breakpoint
CREATE INDEX "settlement_instructions_member_idx" ON "settlement_instructions" USING btree ("tenant_id","member_id","direction","status");--> statement-breakpoint
CREATE UNIQUE INDEX "shadow_results_run_case_uq" ON "shadow_results" USING btree ("run_id","case_id");--> statement-breakpoint
CREATE INDEX "shadow_runs_tenant_idx" ON "shadow_runs" USING btree ("tenant_id","created_at");--> statement-breakpoint
CREATE UNIQUE INDEX "shadow_runs_one_running_uq" ON "shadow_runs" USING btree ("tenant_id") WHERE "shadow_runs"."status" = 'running';--> statement-breakpoint
CREATE UNIQUE INDEX "unattributed_deposits_ref_uq" ON "unattributed_deposits" USING btree ("rail","external_ref");--> statement-breakpoint
CREATE INDEX "unattributed_deposits_tenant_status_idx" ON "unattributed_deposits" USING btree ("tenant_id","status");--> statement-breakpoint
CREATE UNIQUE INDEX "user_invites_token_uq" ON "user_invites" USING btree ("token_hash");--> statement-breakpoint
CREATE INDEX "user_invites_user_idx" ON "user_invites" USING btree ("user_id");--> statement-breakpoint
CREATE UNIQUE INDEX "users_tenant_email_uq" ON "users" USING btree ("tenant_id","email");--> statement-breakpoint
CREATE INDEX "users_email_idx" ON "users" USING btree ("email");--> statement-breakpoint
CREATE UNIQUE INDEX "x402_payments_signature_uq" ON "x402_payments" USING btree ("signature_hash");--> statement-breakpoint
CREATE UNIQUE INDEX "x402_payments_claimed_uq" ON "x402_payments" USING btree ("claimed_ref");--> statement-breakpoint
CREATE INDEX "x402_payments_payer_idx" ON "x402_payments" USING btree ("rail","payer");