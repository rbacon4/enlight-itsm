ALTER TABLE "projects" ADD COLUMN "last_ticket_number" integer DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE "requests" ADD COLUMN "ticket_number" integer DEFAULT 0 NOT NULL;--> statement-breakpoint

-- Backfill: assign sequential ticket numbers within each project ordered by created_at
UPDATE "requests" r
SET "ticket_number" = sub.rn
FROM (
  SELECT id, ROW_NUMBER() OVER (PARTITION BY project_id ORDER BY created_at ASC) AS rn
  FROM "requests"
) sub
WHERE r.id = sub.id;--> statement-breakpoint

-- Sync project counters to the highest ticket number issued
UPDATE "projects" p
SET "last_ticket_number" = COALESCE(
  (SELECT MAX(ticket_number) FROM "requests" WHERE project_id = p.id),
  0
);--> statement-breakpoint

CREATE UNIQUE INDEX "requests_project_ticket_number_idx" ON "requests" USING btree ("project_id","ticket_number");
