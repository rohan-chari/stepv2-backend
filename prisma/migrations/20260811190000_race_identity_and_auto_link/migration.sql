BEGIN;

-- This migration is one explicit atomic schema/backfill unit. The pg_trgm
-- extension and concurrent GIN indexes intentionally live in the required
-- out-of-transaction runbook documented separately.
-- Additive discoverable identity fields. Existing rows remain incomplete and
-- outside the mandatory new-user cohort; provider `name` is not backfilled.
ALTER TABLE "users"
  ADD COLUMN "first_name" TEXT,
  ADD COLUMN "last_name" TEXT,
  ADD COLUMN "discoverable_name_search" TEXT,
  ADD COLUMN "name_setup_onboarding_required" BOOLEAN NOT NULL DEFAULT false,
  ADD COLUMN "name_setup_completed_at" TIMESTAMP(3);

CREATE TABLE "friendship_auto_link_suppressions" (
  "user_a_id" TEXT NOT NULL,
  "user_b_id" TEXT NOT NULL,
  "reason" TEXT NOT NULL DEFAULT 'REMOVED',
  "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "friendship_auto_link_suppressions_pkey"
    PRIMARY KEY ("user_a_id", "user_b_id"),
  CONSTRAINT "friendship_auto_link_suppressions_canonical_pair_check"
    CHECK (user_a_id < user_b_id),
  CONSTRAINT "friendship_auto_link_suppressions_user_a_id_fkey"
    FOREIGN KEY ("user_a_id") REFERENCES "users"("id")
    ON DELETE CASCADE ON UPDATE CASCADE,
  CONSTRAINT "friendship_auto_link_suppressions_user_b_id_fkey"
    FOREIGN KEY ("user_b_id") REFERENCES "users"("id")
    ON DELETE CASCADE ON UPDATE CASCADE
);

-- A deliberate decline predating this release must suppress every new
-- automatic link source. Past removals cannot be reconstructed.
INSERT INTO "friendship_auto_link_suppressions"
  ("user_a_id", "user_b_id", "reason")
SELECT
  LEAST("requester_id", "addressee_id"),
  GREATEST("requester_id", "addressee_id"),
  'DECLINED'
FROM "friendships"
WHERE status = 'DECLINED'
ON CONFLICT ("user_a_id", "user_b_id") DO NOTHING;

CREATE TABLE "friend_search_rate_windows" (
  "user_id" TEXT NOT NULL,
  "window_start" TIMESTAMP(3) NOT NULL,
  "count" INTEGER NOT NULL,
  CONSTRAINT "friend_search_rate_windows_pkey" PRIMARY KEY ("user_id"),
  CONSTRAINT "friend_search_rate_windows_user_id_fkey"
    FOREIGN KEY ("user_id") REFERENCES "users"("id")
    ON DELETE CASCADE ON UPDATE CASCADE
);

COMMIT;
