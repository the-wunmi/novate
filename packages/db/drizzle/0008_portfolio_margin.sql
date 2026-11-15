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
CREATE TABLE "position_marks" (
	"deal_id" uuid NOT NULL,
	"member_id" uuid NOT NULL,
	"rate_e8" bigint NOT NULL,
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
ALTER TABLE "margin_calls" ADD CONSTRAINT "margin_calls_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "margin_calls" ADD CONSTRAINT "margin_calls_member_id_members_id_fk" FOREIGN KEY ("member_id") REFERENCES "public"."members"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "position_marks" ADD CONSTRAINT "position_marks_deal_id_deals_id_fk" FOREIGN KEY ("deal_id") REFERENCES "public"."deals"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "position_marks" ADD CONSTRAINT "position_marks_member_id_members_id_fk" FOREIGN KEY ("member_id") REFERENCES "public"."members"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "unattributed_deposits" ADD CONSTRAINT "unattributed_deposits_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "unattributed_deposits" ADD CONSTRAINT "unattributed_deposits_member_id_members_id_fk" FOREIGN KEY ("member_id") REFERENCES "public"."members"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "margin_calls_one_open_uq" ON "margin_calls" USING btree ("member_id") WHERE "margin_calls"."status" = 'open';--> statement-breakpoint
CREATE INDEX "margin_calls_tenant_status_idx" ON "margin_calls" USING btree ("tenant_id","status");--> statement-breakpoint
CREATE UNIQUE INDEX "position_marks_deal_member_uq" ON "position_marks" USING btree ("deal_id","member_id");--> statement-breakpoint
CREATE UNIQUE INDEX "unattributed_deposits_ref_uq" ON "unattributed_deposits" USING btree ("rail","external_ref");--> statement-breakpoint
CREATE INDEX "unattributed_deposits_tenant_status_idx" ON "unattributed_deposits" USING btree ("tenant_id","status");