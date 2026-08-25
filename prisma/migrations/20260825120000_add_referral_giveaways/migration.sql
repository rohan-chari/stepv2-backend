-- Additive referral qualification facts. Existing rows intentionally remain NULL
-- and therefore cannot be retroactively scored by a future contest.
ALTER TABLE "referrals"
  ADD COLUMN "qualified_at" TIMESTAMP(3),
  ADD COLUMN "qualifying_race_id" TEXT;

CREATE INDEX "referrals_referrer_id_qualified_at_idx"
  ON "referrals"("referrer_id", "qualified_at");
ALTER TABLE "referrals" ADD CONSTRAINT "referrals_qualifying_race_id_fkey"
  FOREIGN KEY ("qualifying_race_id") REFERENCES "races"("id")
  ON DELETE SET NULL ON UPDATE CASCADE;

CREATE TABLE "referral_qualification_intents" (
  "id" TEXT NOT NULL,
  "referral_id" TEXT NOT NULL,
  "qualifying_race_id" TEXT NOT NULL,
  "qualified_at" TIMESTAMP(3) NOT NULL,
  "processed_at" TIMESTAMP(3),
  "attempted_at" TIMESTAMP(3),
  "attempt_count" INTEGER NOT NULL DEFAULT 0,
  "last_error" TEXT,
  "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updated_at" TIMESTAMP(3) NOT NULL,
  CONSTRAINT "referral_qualification_intents_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "referral_qualification_intents_referral_id_fkey"
    FOREIGN KEY ("referral_id") REFERENCES "referrals"("id")
    ON DELETE CASCADE ON UPDATE CASCADE,
  CONSTRAINT "referral_qualification_intents_qualifying_race_id_fkey"
    FOREIGN KEY ("qualifying_race_id") REFERENCES "races"("id")
    ON DELETE RESTRICT ON UPDATE CASCADE
);

CREATE UNIQUE INDEX "referral_qualification_intents_referral_id_qualifying_race__key"
  ON "referral_qualification_intents"("referral_id", "qualifying_race_id");
CREATE INDEX "referral_qualification_intents_processed_at_qualified_at_idx"
  ON "referral_qualification_intents"("processed_at", "qualified_at");

CREATE TABLE "giveaway_contests" (
  "id" TEXT NOT NULL,
  "slug" TEXT NOT NULL,
  "title" TEXT NOT NULL,
  "lifecycle_status" TEXT NOT NULL DEFAULT 'DRAFT',
  "revision" INTEGER NOT NULL DEFAULT 1,
  "governing_time_zone" TEXT NOT NULL,
  "starts_at" TIMESTAMP(3) NOT NULL,
  "ends_at" TIMESTAMP(3) NOT NULL,
  "cash_currency" TEXT NOT NULL DEFAULT 'USD',
  "cash_minor" INTEGER NOT NULL DEFAULT 5000,
  "coin_prize" INTEGER NOT NULL DEFAULT 5000,
  "minimum_age" INTEGER NOT NULL DEFAULT 18,
  "eligible_countries" JSONB NOT NULL DEFAULT '["US"]',
  "eligible_regions" JSONB NOT NULL,
  "sponsor" JSONB NOT NULL,
  "rules_version" TEXT NOT NULL,
  "rules_sections" JSONB NOT NULL,
  "rules_hash" TEXT NOT NULL,
  "social_links" JSONB NOT NULL DEFAULT '[]',
  "banner_message" TEXT NOT NULL,
  "public_reason" TEXT,
  "amended_rules_version" TEXT,
  "published_at" TIMESTAMP(3),
  "frozen_at" TIMESTAMP(3),
  "finalized_at" TIMESTAMP(3),
  "cancelled_at" TIMESTAMP(3),
  "archived_at" TIMESTAMP(3),
  "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updated_at" TIMESTAMP(3) NOT NULL,
  CONSTRAINT "giveaway_contests_pkey" PRIMARY KEY ("id")
);
CREATE UNIQUE INDEX "giveaway_contests_slug_key" ON "giveaway_contests"("slug");
CREATE INDEX "giveaway_contests_lifecycle_status_starts_at_ends_at_idx"
  ON "giveaway_contests"("lifecycle_status", "starts_at", "ends_at");
CREATE INDEX "giveaway_contests_created_at_id_idx" ON "giveaway_contests"("created_at", "id");

CREATE TABLE "giveaway_entrants" (
  "id" TEXT NOT NULL,
  "contest_id" TEXT NOT NULL,
  "user_id" TEXT,
  "entrant_identity_hash" TEXT NOT NULL,
  "identity_hash_version" INTEGER NOT NULL DEFAULT 1,
  "status" TEXT NOT NULL DEFAULT 'ELIGIBLE',
  "country" TEXT NOT NULL,
  "region" TEXT NOT NULL,
  "age_confirmed_at" TIMESTAMP(3) NOT NULL,
  "residency_confirmed_at" TIMESTAMP(3) NOT NULL,
  "rules_accepted_at" TIMESTAMP(3) NOT NULL,
  "accepted_rules_version" TEXT NOT NULL,
  "accepted_rules_hash" TEXT NOT NULL,
  "display_name_snapshot" TEXT,
  "display_name_consented_at" TIMESTAMP(3) NOT NULL,
  "disqualified_reason" TEXT,
  "withdrawn_at" TIMESTAMP(3),
  "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updated_at" TIMESTAMP(3) NOT NULL,
  CONSTRAINT "giveaway_entrants_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "giveaway_entrants_contest_id_fkey" FOREIGN KEY ("contest_id")
    REFERENCES "giveaway_contests"("id") ON DELETE CASCADE ON UPDATE CASCADE,
  CONSTRAINT "giveaway_entrants_user_id_fkey" FOREIGN KEY ("user_id")
    REFERENCES "users"("id") ON DELETE SET NULL ON UPDATE CASCADE
);
CREATE UNIQUE INDEX "giveaway_entrants_contest_id_user_id_key"
  ON "giveaway_entrants"("contest_id", "user_id");
CREATE UNIQUE INDEX "giveaway_entrants_contest_id_entrant_identity_hash_key"
  ON "giveaway_entrants"("contest_id", "entrant_identity_hash");
CREATE INDEX "giveaway_entrants_contest_id_status_idx"
  ON "giveaway_entrants"("contest_id", "status");

CREATE TABLE "giveaway_point_reviews" (
  "id" TEXT NOT NULL,
  "contest_id" TEXT NOT NULL,
  "referral_fact_id" TEXT NOT NULL,
  "decision" TEXT NOT NULL,
  "reason_code" TEXT NOT NULL,
  "private_note" TEXT,
  "actor_id" TEXT NOT NULL,
  "decided_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updated_at" TIMESTAMP(3) NOT NULL,
  CONSTRAINT "giveaway_point_reviews_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "giveaway_point_reviews_contest_id_fkey" FOREIGN KEY ("contest_id")
    REFERENCES "giveaway_contests"("id") ON DELETE CASCADE ON UPDATE CASCADE,
  CONSTRAINT "giveaway_point_reviews_referral_fact_id_fkey" FOREIGN KEY ("referral_fact_id")
    REFERENCES "referrals"("id") ON DELETE RESTRICT ON UPDATE CASCADE
);
CREATE UNIQUE INDEX "giveaway_point_reviews_contest_id_referral_fact_id_key"
  ON "giveaway_point_reviews"("contest_id", "referral_fact_id");
CREATE INDEX "giveaway_point_reviews_contest_id_decision_idx"
  ON "giveaway_point_reviews"("contest_id", "decision");

CREATE TABLE "giveaway_results" (
  "id" TEXT NOT NULL,
  "entrant_id" TEXT NOT NULL,
  "frozen_count" INTEGER NOT NULL,
  "reached_count_at" TIMESTAMP(3),
  "final_rank" INTEGER NOT NULL,
  "status" TEXT NOT NULL DEFAULT 'RANKED',
  "decision_reason" TEXT,
  "selected_at" TIMESTAMP(3),
  "verified_at" TIMESTAMP(3),
  "rejected_at" TIMESTAMP(3),
  "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updated_at" TIMESTAMP(3) NOT NULL,
  CONSTRAINT "giveaway_results_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "giveaway_results_entrant_id_fkey" FOREIGN KEY ("entrant_id")
    REFERENCES "giveaway_entrants"("id") ON DELETE CASCADE ON UPDATE CASCADE
);
CREATE UNIQUE INDEX "giveaway_results_entrant_id_key" ON "giveaway_results"("entrant_id");
CREATE INDEX "giveaway_results_final_rank_idx" ON "giveaway_results"("final_rank");
CREATE INDEX "giveaway_results_status_idx" ON "giveaway_results"("status");

CREATE TABLE "giveaway_fulfillments" (
  "id" TEXT NOT NULL,
  "entrant_id" TEXT NOT NULL,
  "cash_status" TEXT NOT NULL DEFAULT 'UNCLAIMED',
  "cash_provider" TEXT,
  "provider_reference" TEXT,
  "cash_sent_minor" INTEGER,
  "cash_sent_currency" TEXT,
  "cash_sent_at" TIMESTAMP(3),
  "cash_delivered_at" TIMESTAMP(3),
  "coin_transaction_id" TEXT,
  "coins_awarded_at" TIMESTAMP(3),
  "claimed_at" TIMESTAMP(3),
  "fulfilled_at" TIMESTAMP(3),
  "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updated_at" TIMESTAMP(3) NOT NULL,
  CONSTRAINT "giveaway_fulfillments_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "giveaway_fulfillments_entrant_id_fkey" FOREIGN KEY ("entrant_id")
    REFERENCES "giveaway_entrants"("id") ON DELETE RESTRICT ON UPDATE CASCADE
);
CREATE UNIQUE INDEX "giveaway_fulfillments_entrant_id_key"
  ON "giveaway_fulfillments"("entrant_id");
CREATE UNIQUE INDEX "giveaway_fulfillments_coin_transaction_id_key"
  ON "giveaway_fulfillments"("coin_transaction_id");

CREATE TABLE "giveaway_audit_events" (
  "id" TEXT NOT NULL,
  "contest_id" TEXT NOT NULL,
  "actor_id" TEXT NOT NULL,
  "method" TEXT NOT NULL,
  "action" TEXT NOT NULL,
  "idempotency_key" TEXT,
  "request_hash" TEXT,
  "request_body" JSONB,
  "response_body" JSONB,
  "old_state" TEXT,
  "new_state" TEXT,
  "reason" TEXT,
  "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "giveaway_audit_events_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "giveaway_audit_events_contest_id_fkey" FOREIGN KEY ("contest_id")
    REFERENCES "giveaway_contests"("id") ON DELETE CASCADE ON UPDATE CASCADE
);
CREATE UNIQUE INDEX "giveaway_audit_events_actor_id_method_contest_id_idempotenc_key"
  ON "giveaway_audit_events"("actor_id", "method", "contest_id", "idempotency_key");
CREATE INDEX "giveaway_audit_events_contest_id_created_at_idx"
  ON "giveaway_audit_events"("contest_id", "created_at");
