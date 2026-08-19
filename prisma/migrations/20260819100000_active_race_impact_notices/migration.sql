-- Additive, mixed-version-safe presentation/retry state for active-race impact
-- notifications. No existing column/table is changed or repurposed.
CREATE TABLE "active_race_impact_work" (
  "id" TEXT NOT NULL,
  "race_id" TEXT NOT NULL,
  "recipient_user_id" TEXT NOT NULL,
  "source_kind" TEXT NOT NULL,
  "source_id" TEXT NOT NULL,
  "powerup_type" TEXT NOT NULL,
  "status" TEXT NOT NULL DEFAULT 'PENDING',
  "resolved_at" TIMESTAMP(3) NOT NULL,
  "processed_generation" INTEGER,
  "calculation_version" INTEGER NOT NULL DEFAULT 1,
  "inline_receipt_id" TEXT,
  "inline_acknowledged_at" TIMESTAMP(3),
  "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updated_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "active_race_impact_work_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "active_race_impact_work_status_check"
    CHECK ("status" IN ('PENDING', 'ZERO', 'CREATED', 'SUPPRESSED_TERMINAL')),
  CONSTRAINT "active_race_impact_work_calculation_version_check"
    CHECK ("calculation_version" > 0)
);

CREATE UNIQUE INDEX "active_race_impact_work_race_recipient_source_version_key"
  ON "active_race_impact_work"("race_id", "recipient_user_id", "source_kind", "source_id", "calculation_version");
CREATE UNIQUE INDEX "active_race_impact_work_inline_receipt_id_key"
  ON "active_race_impact_work"("inline_receipt_id");
CREATE INDEX "active_race_impact_work_race_status_resolved_id_idx"
  ON "active_race_impact_work"("race_id", "status", "resolved_at", "id");
CREATE INDEX "active_race_impact_work_recipient_status_idx"
  ON "active_race_impact_work"("recipient_user_id", "status");

CREATE TABLE "active_race_effect_impacts" (
  "id" TEXT NOT NULL,
  "race_id" TEXT NOT NULL,
  "user_id" TEXT NOT NULL,
  "work_id" TEXT NOT NULL,
  "source_kind" TEXT NOT NULL,
  "source_id" TEXT NOT NULL,
  "powerup_type" TEXT NOT NULL,
  "delta_steps" INTEGER NOT NULL,
  "value_status" TEXT NOT NULL DEFAULT 'SYNCED_SNAPSHOT',
  "calculation_version" INTEGER NOT NULL DEFAULT 1,
  "source_generation" INTEGER,
  "resolved_at" TIMESTAMP(3) NOT NULL,
  "acknowledged_at" TIMESTAMP(3),
  "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updated_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "active_race_effect_impacts_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "active_race_effect_impacts_value_status_check"
    CHECK ("value_status" = 'SYNCED_SNAPSHOT'),
  CONSTRAINT "active_race_effect_impacts_calculation_version_check"
    CHECK ("calculation_version" > 0)
);

CREATE UNIQUE INDEX "active_race_effect_impacts_work_id_key"
  ON "active_race_effect_impacts"("work_id");
CREATE UNIQUE INDEX "active_race_effect_impacts_race_user_source_version_key"
  ON "active_race_effect_impacts"("race_id", "user_id", "source_kind", "source_id", "calculation_version");
CREATE INDEX "active_race_effect_impacts_delivery_idx"
  ON "active_race_effect_impacts"("race_id", "user_id", "acknowledged_at", "resolved_at", "id");
CREATE INDEX "active_race_effect_impacts_user_resolved_idx"
  ON "active_race_effect_impacts"("user_id", "resolved_at");

ALTER TABLE "active_race_impact_work"
  ADD CONSTRAINT "active_race_impact_work_race_id_fkey"
  FOREIGN KEY ("race_id") REFERENCES "races"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "active_race_impact_work"
  ADD CONSTRAINT "active_race_impact_work_recipient_user_id_fkey"
  FOREIGN KEY ("recipient_user_id") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "active_race_effect_impacts"
  ADD CONSTRAINT "active_race_effect_impacts_race_id_fkey"
  FOREIGN KEY ("race_id") REFERENCES "races"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "active_race_effect_impacts"
  ADD CONSTRAINT "active_race_effect_impacts_user_id_fkey"
  FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "active_race_effect_impacts"
  ADD CONSTRAINT "active_race_effect_impacts_work_id_fkey"
  FOREIGN KEY ("work_id") REFERENCES "active_race_impact_work"("id") ON DELETE CASCADE ON UPDATE CASCADE;
