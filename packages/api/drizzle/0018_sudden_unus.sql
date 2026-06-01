CREATE TYPE "public"."sla_alert_type" AS ENUM('response_breached', 'resolution_breached');--> statement-breakpoint
CREATE TABLE "sla_alerts" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"request_id" uuid NOT NULL,
	"alert_type" "sla_alert_type" NOT NULL,
	"sent_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "sla_alerts" ADD CONSTRAINT "sla_alerts_request_id_requests_id_fk" FOREIGN KEY ("request_id") REFERENCES "public"."requests"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "sla_alerts_request_type_idx" ON "sla_alerts" USING btree ("request_id","alert_type");--> statement-breakpoint
CREATE INDEX "sla_alerts_request_idx" ON "sla_alerts" USING btree ("request_id");