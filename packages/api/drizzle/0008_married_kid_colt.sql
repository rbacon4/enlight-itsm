CREATE TABLE "analytics_reports" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"org_id" uuid NOT NULL,
	"created_by_id" uuid NOT NULL,
	"name" text NOT NULL,
	"description" text,
	"type" text DEFAULT 'custom' NOT NULL,
	"query" text,
	"chart_config" jsonb,
	"shared" boolean DEFAULT true NOT NULL,
	"created_at" timestamp DEFAULT now() NOT NULL,
	"updated_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "analytics_reports" ADD CONSTRAINT "analytics_reports_org_id_organizations_id_fk" FOREIGN KEY ("org_id") REFERENCES "public"."organizations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "analytics_reports" ADD CONSTRAINT "analytics_reports_created_by_id_users_id_fk" FOREIGN KEY ("created_by_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "analytics_reports_org_idx" ON "analytics_reports" USING btree ("org_id");