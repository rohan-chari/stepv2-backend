ALTER TABLE "seeded_challenge_preparations"
  ADD COLUMN "automatic_cursor" TEXT,
  ADD COLUMN "automatic_scan_complete_at" TIMESTAMPTZ(3);
