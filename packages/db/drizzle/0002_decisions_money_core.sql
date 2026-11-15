ALTER TYPE "public"."deal_status" ADD VALUE 'exception';--> statement-breakpoint
CREATE TABLE "api_keys" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"tenant_id" uuid NOT NULL,
	"key_hash" text NOT NULL,
	"name" text NOT NULL,
	"principal" text NOT NULL,
	"member_id" uuid,
	"agent_id" uuid,
	"revoked_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
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
	"status" text DEFAULT 'open' NOT NULL,
	"resolution" jsonb,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"closed_at" timestamp with time zone
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
	"violations" jsonb DEFAULT '[]'::jsonb NOT NULL,
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
	"summary" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
DROP INDEX "obligations_deal_uq";--> statement-breakpoint
ALTER TABLE "cycles" ADD COLUMN "settlement_group" text;--> statement-breakpoint
ALTER TABLE "deals" ADD COLUMN "authority_passed_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "deals" ADD COLUMN "funding_currency" text;--> statement-breakpoint
ALTER TABLE "deals" ADD COLUMN "margin_currency" text;--> statement-breakpoint
ALTER TABLE "obligations" ADD COLUMN "leg" text DEFAULT 'principal' NOT NULL;--> statement-breakpoint
ALTER TABLE "obligations" ADD COLUMN "settlement_group" text;--> statement-breakpoint
ALTER TABLE "settlement_instructions" ADD COLUMN "attempt" integer DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE "tenants" ADD COLUMN "settlement_halted_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "tenants" ADD COLUMN "settlement_halt_reason" text;--> statement-breakpoint
ALTER TABLE "api_keys" ADD CONSTRAINT "api_keys_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "api_keys" ADD CONSTRAINT "api_keys_member_id_members_id_fk" FOREIGN KEY ("member_id") REFERENCES "public"."members"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "api_keys" ADD CONSTRAINT "api_keys_agent_id_agents_id_fk" FOREIGN KEY ("agent_id") REFERENCES "public"."agents"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "decision_cases" ADD CONSTRAINT "decision_cases_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "decision_cases" ADD CONSTRAINT "decision_cases_deal_id_deals_id_fk" FOREIGN KEY ("deal_id") REFERENCES "public"."deals"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "decision_records" ADD CONSTRAINT "decision_records_case_id_decision_cases_id_fk" FOREIGN KEY ("case_id") REFERENCES "public"."decision_cases"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "fx_conversions" ADD CONSTRAINT "fx_conversions_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "fx_conversions" ADD CONSTRAINT "fx_conversions_cycle_id_cycles_id_fk" FOREIGN KEY ("cycle_id") REFERENCES "public"."cycles"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "recon_breaks" ADD CONSTRAINT "recon_breaks_run_id_recon_runs_id_fk" FOREIGN KEY ("run_id") REFERENCES "public"."recon_runs"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "recon_breaks" ADD CONSTRAINT "recon_breaks_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "recon_runs" ADD CONSTRAINT "recon_runs_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "api_keys_hash_uq" ON "api_keys" USING btree ("key_hash");--> statement-breakpoint
CREATE INDEX "decision_cases_tenant_idx" ON "decision_cases" USING btree ("tenant_id","status");--> statement-breakpoint
CREATE INDEX "decision_cases_deal_idx" ON "decision_cases" USING btree ("deal_id");--> statement-breakpoint
CREATE INDEX "decision_records_case_idx" ON "decision_records" USING btree ("case_id");--> statement-breakpoint
CREATE UNIQUE INDEX "fx_conversions_idem_uq" ON "fx_conversions" USING btree ("idempotency_key");--> statement-breakpoint
CREATE UNIQUE INDEX "rail_events_external_uq" ON "rail_events" USING btree ("rail","external_id");--> statement-breakpoint
CREATE INDEX "recon_breaks_run_idx" ON "recon_breaks" USING btree ("run_id");--> statement-breakpoint
CREATE INDEX "recon_runs_tenant_idx" ON "recon_runs" USING btree ("tenant_id","created_at");--> statement-breakpoint
CREATE UNIQUE INDEX "obligations_deal_leg_uq" ON "obligations" USING btree ("deal_id","leg");--> statement-breakpoint
CREATE INDEX "settlement_instructions_ref_idx" ON "settlement_instructions" USING btree ("external_ref");