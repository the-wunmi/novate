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
ALTER TABLE "card_payments" ADD CONSTRAINT "card_payments_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "card_payments" ADD CONSTRAINT "card_payments_deal_id_deals_id_fk" FOREIGN KEY ("deal_id") REFERENCES "public"."deals"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "card_payments" ADD CONSTRAINT "card_payments_member_id_members_id_fk" FOREIGN KEY ("member_id") REFERENCES "public"."members"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "card_payments_mandate_uq" ON "card_payments" USING btree ("mandate_id");--> statement-breakpoint
CREATE UNIQUE INDEX "card_payments_one_open_uq" ON "card_payments" USING btree ("deal_id") WHERE "card_payments"."status" = 'open';--> statement-breakpoint
CREATE INDEX "card_payments_intent_idx" ON "card_payments" USING btree ("intent_id");--> statement-breakpoint
CREATE INDEX "card_payments_tenant_status_idx" ON "card_payments" USING btree ("tenant_id","status");