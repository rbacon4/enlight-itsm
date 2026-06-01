CREATE TYPE "public"."project_access" AS ENUM('open', 'restricted');--> statement-breakpoint
ALTER TABLE "projects" ADD COLUMN "access_type" "project_access" DEFAULT 'open' NOT NULL;--> statement-breakpoint
ALTER TABLE "projects" ADD COLUMN "allowed_slack_user_groups" jsonb DEFAULT '[]' NOT NULL;