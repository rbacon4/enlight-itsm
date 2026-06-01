ALTER TABLE "projects" ADD COLUMN "key" text DEFAULT '' NOT NULL;--> statement-breakpoint

-- Backfill: derive key from slug (first letter of each dash-separated word, uppercase)
-- e.g. "it-helpdesk" → "IH",  "hr-support" → "HS",  "helpdesk" → "HELP"
UPDATE "projects"
SET "key" = CASE
  WHEN ARRAY_LENGTH(STRING_TO_ARRAY(slug, '-'), 1) >= 2
    THEN UPPER(
      (SELECT STRING_AGG(LEFT(word, 1), '' ORDER BY ord)
       FROM UNNEST(STRING_TO_ARRAY(slug, '-')) WITH ORDINALITY AS t(word, ord)
       WHERE word <> '')
    )
  ELSE UPPER(LEFT(REPLACE(slug, '-', ''), 4))
END;--> statement-breakpoint

CREATE UNIQUE INDEX "projects_org_key_idx" ON "projects" USING btree ("org_id","key");
