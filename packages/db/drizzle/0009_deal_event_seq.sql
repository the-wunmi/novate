ALTER TABLE "deal_events" ADD COLUMN "seq" bigserial NOT NULL;--> statement-breakpoint
CREATE INDEX "deal_events_seq_idx" ON "deal_events" USING btree ("seq");