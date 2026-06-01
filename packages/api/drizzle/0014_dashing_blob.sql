CREATE TABLE "offboarding_events" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"org_id" uuid NOT NULL,
	"target_email" text NOT NULL,
	"target_user_id" uuid,
	"delegate_email" text,
	"archive" boolean DEFAULT false NOT NULL,
	"status" text DEFAULT 'pending' NOT NULL,
	"actions" jsonb DEFAULT '[]' NOT NULL,
	"ai_summary" text,
	"error" text,
	"triggered_by_id" uuid,
	"triggered_via" text DEFAULT 'web' NOT NULL,
	"request_id" uuid,
	"slack_message_ts" text,
	"created_at" timestamp DEFAULT now() NOT NULL,
	"updated_at" timestamp DEFAULT now() NOT NULL,
	"completed_at" timestamp
);
--> statement-breakpoint
ALTER TABLE "offboarding_events" ADD CONSTRAINT "offboarding_events_org_id_organizations_id_fk" FOREIGN KEY ("org_id") REFERENCES "public"."organizations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "offboarding_events" ADD CONSTRAINT "offboarding_events_target_user_id_users_id_fk" FOREIGN KEY ("target_user_id") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "offboarding_events" ADD CONSTRAINT "offboarding_events_triggered_by_id_users_id_fk" FOREIGN KEY ("triggered_by_id") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "offboarding_events" ADD CONSTRAINT "offboarding_events_request_id_requests_id_fk" FOREIGN KEY ("request_id") REFERENCES "public"."requests"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "offboarding_events_org_idx" ON "offboarding_events" USING btree ("org_id");--> statement-breakpoint
CREATE INDEX "offboarding_events_created_at_idx" ON "offboarding_events" USING btree ("created_at");