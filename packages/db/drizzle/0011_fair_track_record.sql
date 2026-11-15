ALTER TABLE "decision_cases" ADD COLUMN "judge_after" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "decision_outcomes" ADD COLUMN "program_key" text;--> statement-breakpoint
ALTER TABLE "decision_outcomes" ADD COLUMN "amount" bigint DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE "decision_outcomes" ADD COLUMN "currency" text DEFAULT '' NOT NULL;--> statement-breakpoint
ALTER TABLE "decision_outcomes" ADD COLUMN "pair" text;--> statement-breakpoint
CREATE UNIQUE INDEX "shadow_runs_one_running_uq" ON "shadow_runs" USING btree ("tenant_id") WHERE "shadow_runs"."status" = 'running';