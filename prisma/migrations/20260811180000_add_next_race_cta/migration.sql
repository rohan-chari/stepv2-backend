-- Additive nullable provenance: old code and old app binaries ignore it.
ALTER TABLE "races"
  ADD COLUMN "creation_source" TEXT,
  ADD COLUMN "start_policy" TEXT;

ALTER TABLE "referrals" ADD COLUMN "source_race_id" TEXT;
ALTER TABLE "link_opens" ADD COLUMN "source_race_id" TEXT;

-- Prisma cannot represent partial indexes. These are deliberately maintained
-- as raw migration artifacts and must not be dropped by schema reconciliation.
CREATE INDEX CONCURRENTLY "races_creator_live_quick_idx"
  ON "races" ("creator_id", "created_at" DESC)
  WHERE "creation_source" = 'QUICK_CREATE'
    AND "status" IN ('pending'::"RaceStatus", 'active'::"RaceStatus");

CREATE INDEX CONCURRENTLY "races_open_quick_discovery_idx"
  ON "races" ("status", "created_at" DESC)
  WHERE "creator_id" IS NOT NULL
    AND "is_public" = true
    AND "is_team_race" = false
    AND "buy_in_amount" = 0
    AND "status" IN ('pending'::"RaceStatus", 'active'::"RaceStatus");

CREATE INDEX CONCURRENTLY "race_participants_user_accepted_idx"
  ON "race_participants" ("user_id", "race_id")
  WHERE "status" = 'accepted'::"RaceParticipantStatus";
