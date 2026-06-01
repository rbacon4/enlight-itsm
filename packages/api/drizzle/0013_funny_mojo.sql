ALTER TABLE "users" ADD COLUMN "department" text;--> statement-breakpoint
ALTER TABLE "users" ADD COLUMN "job_title" text;--> statement-breakpoint
ALTER TABLE "users" ADD COLUMN "manager_id" uuid;--> statement-breakpoint
ALTER TABLE "users" ADD COLUMN "city" text;--> statement-breakpoint
ALTER TABLE "users" ADD COLUMN "state" text;--> statement-breakpoint
ALTER TABLE "users" ADD COLUMN "country" text;--> statement-breakpoint
ALTER TABLE "users" ADD CONSTRAINT "users_manager_id_users_id_fk" FOREIGN KEY ("manager_id") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;