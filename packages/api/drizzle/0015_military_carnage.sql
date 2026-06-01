CREATE TABLE "roles" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"org_id" uuid NOT NULL,
	"scope" text NOT NULL,
	"project_id" uuid,
	"key" text NOT NULL,
	"name" text NOT NULL,
	"description" text,
	"color" text,
	"base_tier" text NOT NULL,
	"permissions" jsonb DEFAULT '[]' NOT NULL,
	"is_builtin" boolean DEFAULT false NOT NULL,
	"protected" boolean DEFAULT false NOT NULL,
	"created_at" timestamp DEFAULT now() NOT NULL,
	"updated_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "project_members" ADD COLUMN "role_id" uuid;--> statement-breakpoint
ALTER TABLE "users" ADD COLUMN "role_id" uuid;--> statement-breakpoint
ALTER TABLE "roles" ADD CONSTRAINT "roles_org_id_organizations_id_fk" FOREIGN KEY ("org_id") REFERENCES "public"."organizations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "roles" ADD CONSTRAINT "roles_project_id_projects_id_fk" FOREIGN KEY ("project_id") REFERENCES "public"."projects"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "roles_org_scope_idx" ON "roles" USING btree ("org_id","scope");--> statement-breakpoint
CREATE INDEX "roles_project_idx" ON "roles" USING btree ("project_id");--> statement-breakpoint
ALTER TABLE "project_members" ADD CONSTRAINT "project_members_role_id_roles_id_fk" FOREIGN KEY ("role_id") REFERENCES "public"."roles"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "users" ADD CONSTRAINT "users_role_id_roles_id_fk" FOREIGN KEY ("role_id") REFERENCES "public"."roles"("id") ON DELETE set null ON UPDATE no action;