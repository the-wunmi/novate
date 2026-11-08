CREATE TYPE "public"."deal_status" AS ENUM('submitted', 'authorised', 'frozen', 'awaiting_funding', 'awaiting_conditions', 'held', 'eligible', 'settling', 'settled', 'cancelled', 'rejected', 'refunded');--> statement-breakpoint
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
CREATE TABLE "approvals" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"deal_id" uuid NOT NULL,
	"reason" text NOT NULL,
	"binding_hash" text NOT NULL,
	"shown" jsonb NOT NULL,
	"status" text DEFAULT 'pending' NOT NULL,
	"decision" jsonb,
	"decided_by" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"decided_at" timestamp with time zone
);
--> statement-breakpoint
CREATE TABLE "cycles" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"tenant_id" uuid NOT NULL,
	"status" text DEFAULT 'netting' NOT NULL,
	"summary" jsonb,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"closed_at" timestamp with time zone
);
--> statement-breakpoint
CREATE TABLE "deal_events" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
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
	"status_reason" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "deals_amount_positive" CHECK ("deals"."amount" > 0)
);
--> statement-breakpoint
CREATE TABLE "ledger_accounts" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"tenant_id" uuid NOT NULL,
	"code" text NOT NULL,
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
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "ledger_transfers_amount_positive" CHECK ("ledger_transfers"."amount" > 0),
	CONSTRAINT "ledger_transfers_distinct" CHECK ("ledger_transfers"."debit_account_id" <> "ledger_transfers"."credit_account_id")
);
--> statement-breakpoint
CREATE TABLE "members" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"tenant_id" uuid NOT NULL,
	"name" text NOT NULL,
	"home_currency" text NOT NULL,
	"status" text DEFAULT 'active' NOT NULL,
	"rail_refs" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"attributes" jsonb DEFAULT '{}'::jsonb NOT NULL,
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
	"status" text DEFAULT 'pending' NOT NULL,
	"cycle_id" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "programs" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"tenant_id" uuid NOT NULL,
	"key" text NOT NULL,
	"version" integer NOT NULL,
	"spec" jsonb NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
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
	"external_ref" text,
	"idempotency_key" text NOT NULL,
	"failure_reason" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "settlement_instructions_amount_positive" CHECK ("settlement_instructions"."amount" > 0)
);
--> statement-breakpoint
CREATE TABLE "tenants" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"name" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "agents" ADD CONSTRAINT "agents_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "agents" ADD CONSTRAINT "agents_member_id_members_id_fk" FOREIGN KEY ("member_id") REFERENCES "public"."members"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "approvals" ADD CONSTRAINT "approvals_deal_id_deals_id_fk" FOREIGN KEY ("deal_id") REFERENCES "public"."deals"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "cycles" ADD CONSTRAINT "cycles_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "deal_events" ADD CONSTRAINT "deal_events_deal_id_deals_id_fk" FOREIGN KEY ("deal_id") REFERENCES "public"."deals"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "deal_facts" ADD CONSTRAINT "deal_facts_deal_id_deals_id_fk" FOREIGN KEY ("deal_id") REFERENCES "public"."deals"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "deals" ADD CONSTRAINT "deals_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "deals" ADD CONSTRAINT "deals_program_id_programs_id_fk" FOREIGN KEY ("program_id") REFERENCES "public"."programs"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "deals" ADD CONSTRAINT "deals_buyer_member_id_members_id_fk" FOREIGN KEY ("buyer_member_id") REFERENCES "public"."members"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "deals" ADD CONSTRAINT "deals_seller_member_id_members_id_fk" FOREIGN KEY ("seller_member_id") REFERENCES "public"."members"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "deals" ADD CONSTRAINT "deals_buyer_agent_id_agents_id_fk" FOREIGN KEY ("buyer_agent_id") REFERENCES "public"."agents"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "deals" ADD CONSTRAINT "deals_seller_agent_id_agents_id_fk" FOREIGN KEY ("seller_agent_id") REFERENCES "public"."agents"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "ledger_accounts" ADD CONSTRAINT "ledger_accounts_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "ledger_transfers" ADD CONSTRAINT "ledger_transfers_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "ledger_transfers" ADD CONSTRAINT "ledger_transfers_debit_account_id_ledger_accounts_id_fk" FOREIGN KEY ("debit_account_id") REFERENCES "public"."ledger_accounts"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "ledger_transfers" ADD CONSTRAINT "ledger_transfers_credit_account_id_ledger_accounts_id_fk" FOREIGN KEY ("credit_account_id") REFERENCES "public"."ledger_accounts"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "members" ADD CONSTRAINT "members_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "obligations" ADD CONSTRAINT "obligations_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "obligations" ADD CONSTRAINT "obligations_deal_id_deals_id_fk" FOREIGN KEY ("deal_id") REFERENCES "public"."deals"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "obligations" ADD CONSTRAINT "obligations_payer_member_id_members_id_fk" FOREIGN KEY ("payer_member_id") REFERENCES "public"."members"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "obligations" ADD CONSTRAINT "obligations_payee_member_id_members_id_fk" FOREIGN KEY ("payee_member_id") REFERENCES "public"."members"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "programs" ADD CONSTRAINT "programs_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "settlement_instructions" ADD CONSTRAINT "settlement_instructions_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "settlement_instructions" ADD CONSTRAINT "settlement_instructions_cycle_id_cycles_id_fk" FOREIGN KEY ("cycle_id") REFERENCES "public"."cycles"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "settlement_instructions" ADD CONSTRAINT "settlement_instructions_member_id_members_id_fk" FOREIGN KEY ("member_id") REFERENCES "public"."members"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "agents_member_idx" ON "agents" USING btree ("member_id");--> statement-breakpoint
CREATE INDEX "approvals_deal_idx" ON "approvals" USING btree ("deal_id");--> statement-breakpoint
CREATE INDEX "cycles_tenant_idx" ON "cycles" USING btree ("tenant_id");--> statement-breakpoint
CREATE INDEX "deal_events_deal_idx" ON "deal_events" USING btree ("deal_id","created_at");--> statement-breakpoint
CREATE INDEX "deal_facts_deal_idx" ON "deal_facts" USING btree ("deal_id");--> statement-breakpoint
CREATE UNIQUE INDEX "deals_idempotency_uq" ON "deals" USING btree ("tenant_id","idempotency_key");--> statement-breakpoint
CREATE INDEX "deals_buyer_idx" ON "deals" USING btree ("buyer_member_id");--> statement-breakpoint
CREATE INDEX "deals_seller_idx" ON "deals" USING btree ("seller_member_id");--> statement-breakpoint
CREATE INDEX "deals_buyer_agent_idx" ON "deals" USING btree ("buyer_agent_id");--> statement-breakpoint
CREATE UNIQUE INDEX "ledger_accounts_code_uq" ON "ledger_accounts" USING btree ("tenant_id","code");--> statement-breakpoint
CREATE UNIQUE INDEX "ledger_transfers_idem_uq" ON "ledger_transfers" USING btree ("tenant_id","idempotency_key");--> statement-breakpoint
CREATE INDEX "ledger_transfers_debit_idx" ON "ledger_transfers" USING btree ("debit_account_id");--> statement-breakpoint
CREATE INDEX "ledger_transfers_credit_idx" ON "ledger_transfers" USING btree ("credit_account_id");--> statement-breakpoint
CREATE INDEX "ledger_transfers_ref_idx" ON "ledger_transfers" USING btree ("ref");--> statement-breakpoint
CREATE INDEX "members_tenant_idx" ON "members" USING btree ("tenant_id");--> statement-breakpoint
CREATE UNIQUE INDEX "obligations_deal_uq" ON "obligations" USING btree ("deal_id");--> statement-breakpoint
CREATE INDEX "obligations_eligible_idx" ON "obligations" USING btree ("tenant_id","status");--> statement-breakpoint
CREATE UNIQUE INDEX "programs_key_version_uq" ON "programs" USING btree ("tenant_id","key","version");--> statement-breakpoint
CREATE UNIQUE INDEX "settlement_instructions_idem_uq" ON "settlement_instructions" USING btree ("idempotency_key");--> statement-breakpoint
CREATE INDEX "settlement_instructions_cycle_idx" ON "settlement_instructions" USING btree ("cycle_id");