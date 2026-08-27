ALTER TABLE "global_event_summary_work"
  ADD COLUMN "race_reconciled_at" TIMESTAMP(3);

CREATE INDEX "global_event_summary_work_status_race_reconciled_at_id_idx"
  ON "global_event_summary_work"("status", "race_reconciled_at", "id");
