CREATE TABLE "rail_cursors" (
	"rail" text PRIMARY KEY NOT NULL,
	"position" bigint NOT NULL
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
CREATE UNIQUE INDEX "rail_outgoing_key_uq" ON "rail_outgoing_attempts" USING btree ("rail","idempotency_key");--> statement-breakpoint
CREATE UNIQUE INDEX "rail_outgoing_hash_uq" ON "rail_outgoing_attempts" USING btree ("rail","tx_hash");--> statement-breakpoint
CREATE UNIQUE INDEX "rail_outgoing_nonce_uq" ON "rail_outgoing_attempts" USING btree ("rail","nonce");