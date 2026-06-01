CREATE TABLE "csat_surveys" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"request_id" uuid NOT NULL,
	"token" text NOT NULL,
	"sent_at" timestamp DEFAULT now() NOT NULL,
	"responded_at" timestamp,
	"rating" integer,
	"comment" text
);
--> statement-breakpoint
CREATE TABLE "request_templates" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"project_id" uuid NOT NULL,
	"name" text NOT NULL,
	"description" text,
	"title" text DEFAULT '' NOT NULL,
	"body" text DEFAULT '' NOT NULL,
	"priority" "request_priority" DEFAULT 'medium' NOT NULL,
	"category" text,
	"subcategory" text,
	"custom_fields" jsonb DEFAULT '{}' NOT NULL,
	"created_at" timestamp DEFAULT now() NOT NULL,
	"updated_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "webhook_deliveries" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"webhook_id" uuid NOT NULL,
	"event" text NOT NULL,
	"status_code" integer,
	"response_body" text,
	"duration_ms" integer,
	"success" boolean DEFAULT false NOT NULL,
	"attempt_number" integer DEFAULT 1 NOT NULL,
	"created_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "users" ADD COLUMN "email_preferences" jsonb DEFAULT '{}' NOT NULL;--> statement-breakpoint
ALTER TABLE "csat_surveys" ADD CONSTRAINT "csat_surveys_request_id_requests_id_fk" FOREIGN KEY ("request_id") REFERENCES "public"."requests"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "request_templates" ADD CONSTRAINT "request_templates_project_id_projects_id_fk" FOREIGN KEY ("project_id") REFERENCES "public"."projects"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "webhook_deliveries" ADD CONSTRAINT "webhook_deliveries_webhook_id_webhooks_id_fk" FOREIGN KEY ("webhook_id") REFERENCES "public"."webhooks"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "csat_surveys_request_idx" ON "csat_surveys" USING btree ("request_id");--> statement-breakpoint
CREATE UNIQUE INDEX "csat_surveys_token_idx" ON "csat_surveys" USING btree ("token");--> statement-breakpoint
CREATE INDEX "request_templates_project_idx" ON "request_templates" USING btree ("project_id");--> statement-breakpoint
CREATE INDEX "webhook_deliveries_webhook_idx" ON "webhook_deliveries" USING btree ("webhook_id");--> statement-breakpoint
CREATE INDEX "webhook_deliveries_created_at_idx" ON "webhook_deliveries" USING btree ("created_at");