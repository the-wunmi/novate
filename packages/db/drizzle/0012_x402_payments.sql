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
ALTER TABLE "x402_payments" ADD CONSTRAINT "x402_payments_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "x402_payments" ADD CONSTRAINT "x402_payments_deal_id_deals_id_fk" FOREIGN KEY ("deal_id") REFERENCES "public"."deals"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "x402_payments" ADD CONSTRAINT "x402_payments_member_id_members_id_fk" FOREIGN KEY ("member_id") REFERENCES "public"."members"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "x402_payments_signature_uq" ON "x402_payments" USING btree ("signature_hash");--> statement-breakpoint
CREATE UNIQUE INDEX "x402_payments_claimed_uq" ON "x402_payments" USING btree ("claimed_ref");--> statement-breakpoint
CREATE INDEX "x402_payments_payer_idx" ON "x402_payments" USING btree ("rail","payer");