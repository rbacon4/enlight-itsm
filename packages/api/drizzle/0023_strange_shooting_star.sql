CREATE TABLE "jumpcloud_users" (
	"id" serial PRIMARY KEY NOT NULL,
	"org_id" uuid NOT NULL,
	"jumpcloud_id" varchar(128) NOT NULL,
	"username" varchar(255) NOT NULL,
	"work_email" varchar(255) NOT NULL,
	"display_name" varchar(255),
	"department" varchar(255),
	"title" varchar(255),
	"suspended" boolean DEFAULT false NOT NULL,
	"employment_status" varchar(32) DEFAULT 'ACTIVE' NOT NULL,
	"jumpcloud_data" jsonb,
	"synced_at" timestamp DEFAULT now() NOT NULL,
	"created_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "okta_users" (
	"id" serial PRIMARY KEY NOT NULL,
	"org_id" uuid NOT NULL,
	"okta_id" varchar(128) NOT NULL,
	"login" varchar(255) NOT NULL,
	"email" varchar(255) NOT NULL,
	"display_name" varchar(255),
	"first_name" varchar(255),
	"last_name" varchar(255),
	"department" varchar(255),
	"title" varchar(255),
	"status" varchar(32) DEFAULT 'ACTIVE' NOT NULL,
	"okta_data" jsonb,
	"synced_at" timestamp DEFAULT now() NOT NULL,
	"created_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "org_secrets" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"org_id" uuid NOT NULL,
	"name" varchar(128) NOT NULL,
	"description" text DEFAULT '' NOT NULL,
	"value" text NOT NULL,
	"created_at" timestamp DEFAULT now() NOT NULL,
	"updated_at" timestamp DEFAULT now() NOT NULL,
	"last_used_at" timestamp
);
--> statement-breakpoint
CREATE TABLE "org_variables" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"org_id" uuid NOT NULL,
	"name" varchar(128) NOT NULL,
	"value" text DEFAULT '' NOT NULL,
	"description" text DEFAULT '' NOT NULL,
	"created_at" timestamp DEFAULT now() NOT NULL,
	"updated_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "rippling_workers" (
	"id" serial PRIMARY KEY NOT NULL,
	"org_id" uuid NOT NULL,
	"rippling_id" varchar(128) NOT NULL,
	"work_email" varchar(255) NOT NULL,
	"personal_email" varchar(255),
	"display_name" varchar(255),
	"department" varchar(255),
	"title" varchar(255),
	"employment_status" varchar(32) DEFAULT 'ACTIVE' NOT NULL,
	"rippling_data" jsonb,
	"synced_at" timestamp DEFAULT now() NOT NULL,
	"created_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "jumpcloud_users" ADD CONSTRAINT "jumpcloud_users_org_id_organizations_id_fk" FOREIGN KEY ("org_id") REFERENCES "public"."organizations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "okta_users" ADD CONSTRAINT "okta_users_org_id_organizations_id_fk" FOREIGN KEY ("org_id") REFERENCES "public"."organizations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "org_secrets" ADD CONSTRAINT "org_secrets_org_id_organizations_id_fk" FOREIGN KEY ("org_id") REFERENCES "public"."organizations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "org_variables" ADD CONSTRAINT "org_variables_org_id_organizations_id_fk" FOREIGN KEY ("org_id") REFERENCES "public"."organizations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "rippling_workers" ADD CONSTRAINT "rippling_workers_org_id_organizations_id_fk" FOREIGN KEY ("org_id") REFERENCES "public"."organizations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "jumpcloud_users_org_jc_id" ON "jumpcloud_users" USING btree ("org_id","jumpcloud_id");--> statement-breakpoint
CREATE INDEX "jumpcloud_users_org_email" ON "jumpcloud_users" USING btree ("org_id","work_email");--> statement-breakpoint
CREATE UNIQUE INDEX "okta_users_org_okta_id" ON "okta_users" USING btree ("org_id","okta_id");--> statement-breakpoint
CREATE INDEX "okta_users_org_email" ON "okta_users" USING btree ("org_id","email");--> statement-breakpoint
CREATE INDEX "okta_users_org_login" ON "okta_users" USING btree ("org_id","login");--> statement-breakpoint
CREATE UNIQUE INDEX "org_secrets_org_name_idx" ON "org_secrets" USING btree ("org_id","name");--> statement-breakpoint
CREATE UNIQUE INDEX "org_variables_org_name_idx" ON "org_variables" USING btree ("org_id","name");--> statement-breakpoint
CREATE UNIQUE INDEX "rippling_workers_org_rippling_id" ON "rippling_workers" USING btree ("org_id","rippling_id");--> statement-breakpoint
CREATE INDEX "rippling_workers_org_email" ON "rippling_workers" USING btree ("org_id","work_email");