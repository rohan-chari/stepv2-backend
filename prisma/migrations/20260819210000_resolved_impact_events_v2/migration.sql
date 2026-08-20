-- Additive v2 replacement for active-impact presentation work. The v1 tables
-- deliberately remain intact for the separately approved rollback window.
CREATE TABLE "race_impact_events" (
    "id" TEXT NOT NULL,
    "race_id" TEXT NOT NULL,
    "recipient_user_id" TEXT NOT NULL,
    "source_kind" TEXT NOT NULL,
    "source_id" TEXT NOT NULL,
    "source_feed_event_id" TEXT,
    "powerup_type" TEXT NOT NULL,
    "delta_steps" INTEGER NOT NULL,
    "description" TEXT NOT NULL,
    "value_status" TEXT NOT NULL DEFAULT 'SYNCED_SNAPSHOT',
    "calculation_version" INTEGER NOT NULL DEFAULT 2,
    "resolved_at" TIMESTAMP(3) NOT NULL,
    "popup_acknowledged_at" TIMESTAMP(3),
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "race_impact_events_pkey" PRIMARY KEY ("id"),
    CONSTRAINT "race_impact_events_nonzero_delta" CHECK ("delta_steps" <> 0),
    CONSTRAINT "race_impact_events_v2_value_status" CHECK ("value_status" = 'SYNCED_SNAPSHOT'),
    CONSTRAINT "race_impact_events_calculation_version" CHECK ("calculation_version" = 2)
);

CREATE UNIQUE INDEX "race_impact_events_source_key"
ON "race_impact_events"("race_id", "recipient_user_id", "source_kind", "source_id", "calculation_version");

CREATE INDEX "race_impact_events_unacknowledged_popup"
ON "race_impact_events"("race_id", "recipient_user_id", "resolved_at" DESC, "id" DESC)
WHERE "popup_acknowledged_at" IS NULL;

CREATE INDEX "race_impact_events_private_activity"
ON "race_impact_events"("race_id", "recipient_user_id", "resolved_at" DESC, "id" DESC);

ALTER TABLE "race_impact_events"
ADD CONSTRAINT "race_impact_events_race_id_fkey"
FOREIGN KEY ("race_id") REFERENCES "races"("id") ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE "race_impact_events"
ADD CONSTRAINT "race_impact_events_recipient_user_id_fkey"
FOREIGN KEY ("recipient_user_id") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE "race_impact_events"
ADD CONSTRAINT "race_impact_events_source_feed_event_id_fkey"
FOREIGN KEY ("source_feed_event_id") REFERENCES "race_powerup_events"("id") ON DELETE SET NULL ON UPDATE CASCADE;

CREATE TABLE "race_umbrella_interceptions" (
    "id" TEXT NOT NULL,
    "race_id" TEXT NOT NULL,
    "recipient_user_id" TEXT NOT NULL,
    "umbrella_effect_id" TEXT NOT NULL,
    "rainstorm_powerup_id" TEXT NOT NULL,
    "window_start" TIMESTAMP(3) NOT NULL,
    "resolves_at" TIMESTAMP(3) NOT NULL,
    "avoided_multiplier" DECIMAL(8,6) NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'PENDING',
    "resolved_at" TIMESTAMP(3),
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,
    CONSTRAINT "race_umbrella_interceptions_pkey" PRIMARY KEY ("id"),
    CONSTRAINT "race_umbrella_interceptions_status" CHECK ("status" IN ('PENDING', 'RESOLVED'))
);

CREATE UNIQUE INDEX "race_umbrella_interceptions_source_key"
ON "race_umbrella_interceptions"("rainstorm_powerup_id", "recipient_user_id");

CREATE INDEX "race_umbrella_interceptions_due"
ON "race_umbrella_interceptions"("race_id", "status", "resolves_at", "id");

ALTER TABLE "race_umbrella_interceptions"
ADD CONSTRAINT "race_umbrella_interceptions_race_id_fkey"
FOREIGN KEY ("race_id") REFERENCES "races"("id") ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE "race_umbrella_interceptions"
ADD CONSTRAINT "race_umbrella_interceptions_recipient_user_id_fkey"
FOREIGN KEY ("recipient_user_id") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- Exact due-effect selector used by C0. Kept as raw migration schema drift
-- because Prisma cannot express the required ordering/predicate together.
CREATE INDEX "race_active_effects_due_resolution_v2"
ON "race_active_effects"("race_id", "status", "expires_at", "id")
WHERE "expires_at" IS NOT NULL;
