CREATE TABLE "offboarding_checklist_steps" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"checklist_id" uuid NOT NULL,
	"org_id" uuid NOT NULL,
	"position" integer DEFAULT 0 NOT NULL,
	"type" text DEFAULT 'manual' NOT NULL,
	"name" text NOT NULL,
	"description" text,
	"enabled" boolean DEFAULT true NOT NULL,
	"method" text,
	"url" text,
	"headers" jsonb DEFAULT '{}' NOT NULL,
	"body_template" text,
	"auth_type" text DEFAULT 'none' NOT NULL,
	"auth_header_name" text,
	"credential_enc" text,
	"expected_status_min" integer DEFAULT 200 NOT NULL,
	"expected_status_max" integer DEFAULT 299 NOT NULL,
	"schema_text" text,
	"created_at" timestamp DEFAULT now() NOT NULL,
	"updated_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "offboarding_checklists" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"org_id" uuid NOT NULL,
	"name" text NOT NULL,
	"description" text,
	"is_default" boolean DEFAULT false NOT NULL,
	"created_at" timestamp DEFAULT now() NOT NULL,
	"updated_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "offboarding_events" ADD COLUMN "checklist_id" uuid;--> statement-breakpoint
ALTER TABLE "offboarding_events" ADD COLUMN "manual_steps" jsonb DEFAULT '[]' NOT NULL;--> statement-breakpoint
ALTER TABLE "offboarding_checklist_steps" ADD CONSTRAINT "offboarding_checklist_steps_checklist_id_offboarding_checklists_id_fk" FOREIGN KEY ("checklist_id") REFERENCES "public"."offboarding_checklists"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "offboarding_checklist_steps" ADD CONSTRAINT "offboarding_checklist_steps_org_id_organizations_id_fk" FOREIGN KEY ("org_id") REFERENCES "public"."organizations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "offboarding_checklists" ADD CONSTRAINT "offboarding_checklists_org_id_organizations_id_fk" FOREIGN KEY ("org_id") REFERENCES "public"."organizations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "offboarding_checklist_steps_checklist_idx" ON "offboarding_checklist_steps" USING btree ("checklist_id");--> statement-breakpoint
CREATE INDEX "offboarding_checklists_org_idx" ON "offboarding_checklists" USING btree ("org_id");--> statement-breakpoint
ALTER TABLE "offboarding_events" ADD CONSTRAINT "offboarding_events_checklist_id_offboarding_checklists_id_fk" FOREIGN KEY ("checklist_id") REFERENCES "public"."offboarding_checklists"("id") ON DELETE set null ON UPDATE no action;