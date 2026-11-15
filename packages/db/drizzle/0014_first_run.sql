CREATE TABLE "instance_setup" (
	"id" boolean PRIMARY KEY DEFAULT true NOT NULL,
	"default_tenant_id" uuid NOT NULL,
	"operator_key_hash" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "instance_setup" ADD CONSTRAINT "instance_setup_default_tenant_id_tenants_id_fk" FOREIGN KEY ("default_tenant_id") REFERENCES "public"."tenants"("id") ON DELETE no action ON UPDATE no action;