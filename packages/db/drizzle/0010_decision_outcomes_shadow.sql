CREATE TABLE "decision_outcomes" (
	"case_id" uuid PRIMARY KEY NOT NULL,
	"tenant_id" uuid NOT NULL,
	"kind" text NOT NULL,
	"action_type" text NOT NULL,
	"verdict" text NOT NULL,
	"signals" jsonb NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "shadow_results" (
	"run_id" uuid NOT NULL,
	"case_id" uuid NOT NULL,
	"recorded" text NOT NULL,
	"candidate" text NOT NULL,
	"rationale" text,
	"verdict" text,
	"violations" jsonb DEFAULT '[]'::jsonb NOT NULL,
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
ALTER TABLE "decision_outcomes" ADD CONSTRAINT "decision_outcomes_case_id_decision_cases_id_fk" FOREIGN KEY ("case_id") REFERENCES "public"."decision_cases"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "decision_outcomes" ADD CONSTRAINT "decision_outcomes_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "shadow_results" ADD CONSTRAINT "shadow_results_run_id_shadow_runs_id_fk" FOREIGN KEY ("run_id") REFERENCES "public"."shadow_runs"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "shadow_results" ADD CONSTRAINT "shadow_results_case_id_decision_cases_id_fk" FOREIGN KEY ("case_id") REFERENCES "public"."decision_cases"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "shadow_runs" ADD CONSTRAINT "shadow_runs_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "decision_outcomes_tenant_kind_idx" ON "decision_outcomes" USING btree ("tenant_id","kind","created_at");--> statement-breakpoint
CREATE UNIQUE INDEX "shadow_results_run_case_uq" ON "shadow_results" USING btree ("run_id","case_id");--> statement-breakpoint
CREATE INDEX "shadow_runs_tenant_idx" ON "shadow_runs" USING btree ("tenant_id","created_at");