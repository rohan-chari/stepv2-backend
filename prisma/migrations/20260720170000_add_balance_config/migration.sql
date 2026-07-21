-- Balance config: versioned, append-only game-balance configuration.
-- Purely ADDITIVE. Old code never reads either object; rolling this back is a
-- pair of DROPs and the app falls back to its code defaults (D4).

CREATE TABLE "balance_config" (
    "id" TEXT NOT NULL,
    "version" INTEGER NOT NULL,
    "config" JSONB NOT NULL,
    "note" TEXT,
    "created_by" TEXT,
    "bound_override" BOOLEAN NOT NULL DEFAULT false,
    "active" BOOLEAN NOT NULL DEFAULT false,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "balance_config_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "balance_config_version_key" ON "balance_config"("version");
CREATE INDEX "balance_config_active_idx" ON "balance_config"("active");

-- Roll provenance. Nullable, no backfill: pre-existing rows stay NULL.
ALTER TABLE "race_powerups" ADD COLUMN "config_version" INTEGER;
