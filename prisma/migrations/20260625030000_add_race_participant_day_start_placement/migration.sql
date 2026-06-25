-- Daily biggest-mover digest: this participant's live rank captured at the last
-- 4pm-ET digest run, the baseline the next run measures movement against (a
-- rolling 24h window). NULL = not yet seeded; the digest job lazily seeds it and
-- emits nothing for that first partial window, then resets it to the current live
-- rank on every run. Additive + nullable, so already-shipped app versions (which
-- never read or write it) behave exactly as before.
ALTER TABLE "race_participants" ADD COLUMN "day_start_placement" INTEGER;
