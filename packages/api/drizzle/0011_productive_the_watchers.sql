CREATE TABLE "automation_rules" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"project_id" uuid NOT NULL,
	"name" text NOT NULL,
	"enabled" boolean DEFAULT true NOT NULL,
	"trigger" jsonb NOT NULL,
	"conditions" jsonb DEFAULT '[]' NOT NULL,
	"actions" jsonb DEFAULT '[]' NOT NULL,
	"last_triggered_at" timestamp,
	"trigger_count" integer DEFAULT 0 NOT NULL,
	"created_at" timestamp DEFAULT now() NOT NULL,
	"updated_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "automation_runs" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"rule_id" uuid NOT NULL,
	"request_id" uuid NOT NULL,
	"status" text NOT NULL,
	"detail" text,
	"created_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "automation_rules" ADD CONSTRAINT "automation_rules_project_id_projects_id_fk" FOREIGN KEY ("project_id") REFERENCES "public"."projects"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "automation_runs" ADD CONSTRAINT "automation_runs_rule_id_automation_rules_id_fk" FOREIGN KEY ("rule_id") REFERENCES "public"."automation_rules"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "automation_runs" ADD CONSTRAINT "automation_runs_request_id_requests_id_fk" FOREIGN KEY ("request_id") REFERENCES "public"."requests"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "automation_rules_project_idx" ON "automation_rules" USING btree ("project_id");--> statement-breakpoint
CREATE INDEX "automation_runs_rule_idx" ON "automation_runs" USING btree ("rule_id");--> statement-breakpoint
CREATE INDEX "automation_runs_rule_request_idx" ON "automation_runs" USING btree ("rule_id","request_id");