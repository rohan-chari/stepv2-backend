-- Expand-only interstitial accounting. Frozen clients never call these new
-- endpoints or read these tables, and all existing rewarded-ad persistence is
-- intentionally untouched.

CREATE TYPE "InterstitialAdPlacement" AS ENUM (
  'race_detail_exit',
  'race_results_exit'
);

CREATE TYPE "InterstitialAdPlatform" AS ENUM ('ios', 'android');

CREATE TABLE "interstitial_ad_caps" (
  "user_id" TEXT NOT NULL,
  "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updated_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "interstitial_ad_caps_pkey" PRIMARY KEY ("user_id")
);

CREATE TABLE "interstitial_ad_permits" (
  "id" UUID NOT NULL DEFAULT gen_random_uuid(),
  "user_id" TEXT NOT NULL,
  "placement" "InterstitialAdPlacement" NOT NULL,
  "session_id" UUID NOT NULL,
  "cap_date" DATE NOT NULL,
  "time_zone" VARCHAR(128) NOT NULL,
  "app_version" VARCHAR(32) NOT NULL,
  "platform" "InterstitialAdPlatform" NOT NULL,
  "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "show_by" TIMESTAMP(3) NOT NULL,
  "reservation_until" TIMESTAMP(3) NOT NULL,
  "cancelled_at" TIMESTAMP(3),
  "confirmed_at" TIMESTAMP(3),
  CONSTRAINT "interstitial_ad_permits_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "interstitial_ad_permits_deadline_check"
    CHECK ("show_by" > "created_at" AND "reservation_until" > "show_by")
);

CREATE TABLE "interstitial_ad_impressions" (
  "id" UUID NOT NULL DEFAULT gen_random_uuid(),
  "event_id" UUID NOT NULL,
  "permit_id" UUID NOT NULL,
  "user_id" TEXT NOT NULL,
  "placement" "InterstitialAdPlacement" NOT NULL,
  "cap_date" DATE NOT NULL,
  "time_zone" VARCHAR(128) NOT NULL,
  "session_id" UUID NOT NULL,
  "occurred_at" TIMESTAMP(3) NOT NULL,
  "received_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "app_version" VARCHAR(32) NOT NULL,
  "platform" "InterstitialAdPlatform" NOT NULL,
  CONSTRAINT "interstitial_ad_impressions_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "interstitial_ad_impressions_event_id_key"
  ON "interstitial_ad_impressions"("event_id");
CREATE UNIQUE INDEX "interstitial_ad_impressions_permit_id_key"
  ON "interstitial_ad_impressions"("permit_id");

CREATE INDEX "interstitial_ad_permits_user_id_reservation_until_idx"
  ON "interstitial_ad_permits"("user_id", "reservation_until");
CREATE INDEX "interstitial_ad_permits_user_id_cap_date_idx"
  ON "interstitial_ad_permits"("user_id", "cap_date");
CREATE INDEX "interstitial_ad_permits_user_id_session_id_idx"
  ON "interstitial_ad_permits"("user_id", "session_id");

CREATE INDEX "interstitial_ad_impressions_user_id_received_at_idx"
  ON "interstitial_ad_impressions"("user_id", "received_at");
CREATE INDEX "interstitial_ad_impressions_user_id_cap_date_idx"
  ON "interstitial_ad_impressions"("user_id", "cap_date");
CREATE INDEX "interstitial_ad_impressions_user_id_session_id_idx"
  ON "interstitial_ad_impressions"("user_id", "session_id");
CREATE INDEX "interstitial_ad_impressions_placement_received_at_idx"
  ON "interstitial_ad_impressions"("placement", "received_at");

ALTER TABLE "interstitial_ad_caps"
  ADD CONSTRAINT "interstitial_ad_caps_user_id_fkey"
    FOREIGN KEY ("user_id") REFERENCES "users"("id")
    ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE "interstitial_ad_permits"
  ADD CONSTRAINT "interstitial_ad_permits_user_id_fkey"
    FOREIGN KEY ("user_id") REFERENCES "users"("id")
    ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE "interstitial_ad_impressions"
  ADD CONSTRAINT "interstitial_ad_impressions_user_id_fkey"
    FOREIGN KEY ("user_id") REFERENCES "users"("id")
    ON DELETE CASCADE ON UPDATE CASCADE,
  ADD CONSTRAINT "interstitial_ad_impressions_permit_id_fkey"
    FOREIGN KEY ("permit_id") REFERENCES "interstitial_ad_permits"("id")
    ON DELETE CASCADE ON UPDATE CASCADE;
