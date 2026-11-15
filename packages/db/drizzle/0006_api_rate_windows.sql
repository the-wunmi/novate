CREATE TABLE "api_rate_windows" (
	"key_id" text NOT NULL,
	"window_start" timestamp with time zone NOT NULL,
	"requests" integer DEFAULT 1 NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX "api_rate_windows_uq" ON "api_rate_windows" USING btree ("key_id","window_start");