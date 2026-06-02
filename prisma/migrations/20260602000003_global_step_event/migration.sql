-- Global step-multiplier event (BeReal-style 2x event), 1.1.7. ADDITIVE ONLY.
--
-- Back-compat: this migration only CREATEs a brand-new table + index. No
-- existing table, column, enum value, or constraint is dropped, renamed, or made
-- NOT NULL. Old app binaries and the currently-deployed backend are unaffected;
-- during an event, old apps simply show a higher (correct) step total with no
-- banner. All objects are guarded with IF NOT EXISTS so re-applying is a no-op.

CREATE TABLE IF NOT EXISTS "global_step_events" (
  "id"         TEXT NOT NULL,
  "starts_at"  TIMESTAMP(3) NOT NULL,
  "ends_at"    TIMESTAMP(3) NOT NULL,
  "multiplier" DOUBLE PRECISION NOT NULL DEFAULT 2,
  "label"      TEXT,
  "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "global_step_events_pkey" PRIMARY KEY ("id")
);

CREATE INDEX IF NOT EXISTS "global_step_events_starts_at_ends_at_idx"
  ON "global_step_events" ("starts_at", "ends_at");
