-- Global boundary scheduler selector. This is separate from the race-scoped
-- C0 index because the scheduler starts from resolves_at and reads only live
-- domain sources; it never scans feed or notification history.
CREATE INDEX "race_umbrella_interceptions_due_pending"
ON "race_umbrella_interceptions"("resolves_at", "race_id", "id")
WHERE "status" = 'PENDING';
