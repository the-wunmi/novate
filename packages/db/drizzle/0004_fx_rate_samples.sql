CREATE TABLE "fx_rate_samples" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"sell_currency" text NOT NULL,
	"buy_currency" text NOT NULL,
	"rate_e8" bigint NOT NULL,
	"sampled_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE INDEX "fx_rate_samples_pair_idx" ON "fx_rate_samples" USING btree ("sell_currency","buy_currency","sampled_at");