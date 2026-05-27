-- Per-seed powerup config for seeded (daily/weekly) public races. Additive and
-- backward-compatible: existing seeds default to powerups off, so behavior is
-- unchanged until a seed row opts in.
ALTER TABLE "race_seeds" ADD COLUMN "powerups_enabled" BOOLEAN NOT NULL DEFAULT false;
ALTER TABLE "race_seeds" ADD COLUMN "powerup_step_interval" INTEGER;
