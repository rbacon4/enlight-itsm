CREATE TYPE "public"."ai_model" AS ENUM('claude-opus-4-5', 'claude-sonnet-4-5', 'claude-haiku-4-5');--> statement-breakpoint
CREATE TYPE "public"."global_role" AS ENUM('super_admin', 'admin', 'agent', 'viewer');--> statement-breakpoint
CREATE TYPE "public"."knowledge_file_type" AS ENUM('pdf', 'txt', 'rtf', 'docx');--> statement-breakpoint
CREATE TYPE "public"."knowledge_source_status" AS ENUM('active', 'syncing', 'error', 'pending');--> statement-breakpoint
CREATE TYPE "public"."knowledge_source_type" AS ENUM('confluence', 'gdrive', 'notion', 'file');--> statement-breakpoint
CREATE TYPE "public"."mcp_permission_level" AS ENUM('read', 'read_write');--> statement-breakpoint
CREATE TYPE "public"."project_role" AS ENUM('admin', 'agent', 'viewer');--> statement-breakpoint
CREATE TYPE "public"."project_status" AS ENUM('active', 'archived');--> statement-breakpoint
CREATE TYPE "public"."request_priority" AS ENUM('critical', 'high', 'medium', 'low');--> statement-breakpoint
CREATE TYPE "public"."request_status" AS ENUM('open', 'in_progress', 'pending_user', 'resolved', 'closed');--> statement-breakpoint
CREATE TABLE "ai_actions" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"request_id" uuid NOT NULL,
	"action_type" text NOT NULL,
	"model" "ai_model" NOT NULL,
	"input_tokens" integer NOT NULL,
	"output_tokens" integer NOT NULL,
	"confidence" integer,
	"rationale" text,
	"created_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "attachments" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"request_id" uuid NOT NULL,
	"uploader_id" uuid NOT NULL,
	"gcs_object_key" text NOT NULL,
	"filename" text NOT NULL,
	"content_type" text NOT NULL,
	"size_bytes" integer NOT NULL,
	"created_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "audit_logs" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"org_id" uuid NOT NULL,
	"actor_id" uuid,
	"action" text NOT NULL,
	"entity_type" text NOT NULL,
	"entity_id" text NOT NULL,
	"diff" jsonb,
	"created_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "comments" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"request_id" uuid NOT NULL,
	"author_id" uuid NOT NULL,
	"body" text NOT NULL,
	"is_internal" boolean DEFAULT false NOT NULL,
	"ai_generated" boolean DEFAULT false NOT NULL,
	"created_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "knowledge_chunks" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"source_id" uuid NOT NULL,
	"title" text NOT NULL,
	"body" text NOT NULL,
	"embedding" vector(1536),
	"source_url" text,
	"metadata" jsonb DEFAULT '{}' NOT NULL,
	"created_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "knowledge_sources" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"project_id" uuid NOT NULL,
	"type" "knowledge_source_type" NOT NULL,
	"file_type" "knowledge_file_type",
	"config" jsonb DEFAULT '{}' NOT NULL,
	"chunk_size" integer DEFAULT 512 NOT NULL,
	"chunk_overlap" integer DEFAULT 64 NOT NULL,
	"min_chunk_size" integer DEFAULT 64 NOT NULL,
	"oauth_secret_ref" text,
	"last_synced_at" timestamp,
	"status" "knowledge_source_status" DEFAULT 'pending' NOT NULL,
	"document_count" integer DEFAULT 0 NOT NULL,
	"error_message" text,
	"created_at" timestamp DEFAULT now() NOT NULL,
	"updated_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "mcp_api_keys" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"org_id" uuid NOT NULL,
	"key_hash" text NOT NULL,
	"name" text NOT NULL,
	"permission_level" "mcp_permission_level" DEFAULT 'read' NOT NULL,
	"project_ids" jsonb DEFAULT '[]' NOT NULL,
	"created_at" timestamp DEFAULT now() NOT NULL,
	"last_used_at" timestamp
);
--> statement-breakpoint
CREATE TABLE "organizations" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"name" text NOT NULL,
	"saml_config" jsonb,
	"scim_token_hash" text,
	"email_sender_config" jsonb,
	"settings" jsonb DEFAULT '{}' NOT NULL,
	"created_at" timestamp DEFAULT now() NOT NULL,
	"updated_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "project_members" (
	"project_id" uuid NOT NULL,
	"user_id" uuid NOT NULL,
	"role" "project_role" NOT NULL,
	"created_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "projects" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"org_id" uuid NOT NULL,
	"name" text NOT NULL,
	"slug" text NOT NULL,
	"description" text,
	"icon" text,
	"ai_model" "ai_model" DEFAULT 'claude-sonnet-4-5' NOT NULL,
	"ai_instructions" text,
	"ai_autonomous_mode" boolean DEFAULT false NOT NULL,
	"ai_escalation_threshold" integer DEFAULT 80 NOT NULL,
	"sla_policies" jsonb DEFAULT '[]' NOT NULL,
	"sla_alert_config" jsonb DEFAULT '{"channels":[]}' NOT NULL,
	"categories" jsonb DEFAULT '[]' NOT NULL,
	"custom_fields" jsonb DEFAULT '[]' NOT NULL,
	"default_assignee_id" uuid,
	"escalation_path" text,
	"status" "project_status" DEFAULT 'active' NOT NULL,
	"created_at" timestamp DEFAULT now() NOT NULL,
	"updated_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "requests" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"project_id" uuid NOT NULL,
	"title" text NOT NULL,
	"description" text DEFAULT '' NOT NULL,
	"status" "request_status" DEFAULT 'open' NOT NULL,
	"priority" "request_priority" DEFAULT 'medium' NOT NULL,
	"category" text,
	"subcategory" text,
	"requester_id" uuid NOT NULL,
	"assignee_id" uuid,
	"custom_fields" jsonb DEFAULT '{}' NOT NULL,
	"slack_thread_ts" text,
	"slack_user_id" text,
	"created_at" timestamp DEFAULT now() NOT NULL,
	"updated_at" timestamp DEFAULT now() NOT NULL,
	"resolved_at" timestamp
);
--> statement-breakpoint
CREATE TABLE "users" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"org_id" uuid NOT NULL,
	"email" text NOT NULL,
	"name" text NOT NULL,
	"password_hash" text,
	"external_id" text,
	"saml_name_id" text,
	"global_role" "global_role" DEFAULT 'viewer' NOT NULL,
	"slack_user_id" text,
	"created_at" timestamp DEFAULT now() NOT NULL,
	"updated_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "ai_actions" ADD CONSTRAINT "ai_actions_request_id_requests_id_fk" FOREIGN KEY ("request_id") REFERENCES "public"."requests"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "attachments" ADD CONSTRAINT "attachments_request_id_requests_id_fk" FOREIGN KEY ("request_id") REFERENCES "public"."requests"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "attachments" ADD CONSTRAINT "attachments_uploader_id_users_id_fk" FOREIGN KEY ("uploader_id") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "audit_logs" ADD CONSTRAINT "audit_logs_org_id_organizations_id_fk" FOREIGN KEY ("org_id") REFERENCES "public"."organizations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "audit_logs" ADD CONSTRAINT "audit_logs_actor_id_users_id_fk" FOREIGN KEY ("actor_id") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "comments" ADD CONSTRAINT "comments_request_id_requests_id_fk" FOREIGN KEY ("request_id") REFERENCES "public"."requests"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "comments" ADD CONSTRAINT "comments_author_id_users_id_fk" FOREIGN KEY ("author_id") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "knowledge_chunks" ADD CONSTRAINT "knowledge_chunks_source_id_knowledge_sources_id_fk" FOREIGN KEY ("source_id") REFERENCES "public"."knowledge_sources"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "knowledge_sources" ADD CONSTRAINT "knowledge_sources_project_id_projects_id_fk" FOREIGN KEY ("project_id") REFERENCES "public"."projects"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "mcp_api_keys" ADD CONSTRAINT "mcp_api_keys_org_id_organizations_id_fk" FOREIGN KEY ("org_id") REFERENCES "public"."organizations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "project_members" ADD CONSTRAINT "project_members_project_id_projects_id_fk" FOREIGN KEY ("project_id") REFERENCES "public"."projects"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "project_members" ADD CONSTRAINT "project_members_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "projects" ADD CONSTRAINT "projects_org_id_organizations_id_fk" FOREIGN KEY ("org_id") REFERENCES "public"."organizations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "requests" ADD CONSTRAINT "requests_project_id_projects_id_fk" FOREIGN KEY ("project_id") REFERENCES "public"."projects"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "requests" ADD CONSTRAINT "requests_requester_id_users_id_fk" FOREIGN KEY ("requester_id") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "requests" ADD CONSTRAINT "requests_assignee_id_users_id_fk" FOREIGN KEY ("assignee_id") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "users" ADD CONSTRAINT "users_org_id_organizations_id_fk" FOREIGN KEY ("org_id") REFERENCES "public"."organizations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "audit_logs_org_idx" ON "audit_logs" USING btree ("org_id");--> statement-breakpoint
CREATE INDEX "audit_logs_entity_idx" ON "audit_logs" USING btree ("entity_type","entity_id");--> statement-breakpoint
CREATE INDEX "audit_logs_created_at_idx" ON "audit_logs" USING btree ("created_at");--> statement-breakpoint
CREATE INDEX "knowledge_chunks_source_idx" ON "knowledge_chunks" USING btree ("source_id");--> statement-breakpoint
CREATE UNIQUE INDEX "project_members_pk" ON "project_members" USING btree ("project_id","user_id");--> statement-breakpoint
CREATE UNIQUE INDEX "projects_org_slug_idx" ON "projects" USING btree ("org_id","slug");--> statement-breakpoint
CREATE INDEX "requests_project_status_idx" ON "requests" USING btree ("project_id","status");--> statement-breakpoint
CREATE INDEX "requests_assignee_idx" ON "requests" USING btree ("assignee_id");--> statement-breakpoint
CREATE INDEX "requests_requester_idx" ON "requests" USING btree ("requester_id");--> statement-breakpoint
CREATE INDEX "requests_slack_thread_idx" ON "requests" USING btree ("slack_thread_ts");--> statement-breakpoint
CREATE UNIQUE INDEX "users_org_email_idx" ON "users" USING btree ("org_id","email");--> statement-breakpoint
CREATE INDEX "users_slack_user_id_idx" ON "users" USING btree ("slack_user_id");