CREATE TABLE "oncall_schedules" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"project_id" uuid NOT NULL,
	"name" text NOT NULL,
	"timezone" text DEFAULT 'UTC' NOT NULL,
	"rotation_days" integer DEFAULT 7 NOT NULL,
	"handoff_time" text DEFAULT '09:00' NOT NULL,
	"start_date" text NOT NULL,
	"participants" jsonb DEFAULT '[]' NOT NULL,
	"created_at" timestamp DEFAULT now() NOT NULL,
	"updated_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "projects" ADD COLUMN "support_hours" jsonb;--> statement-breakpoint
ALTER TABLE "oncall_schedules" ADD CONSTRAINT "oncall_schedules_project_id_projects_id_fk" FOREIGN KEY ("project_id") REFERENCES "public"."projects"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "oncall_schedules_project_idx" ON "oncall_schedules" USING btree ("project_id");