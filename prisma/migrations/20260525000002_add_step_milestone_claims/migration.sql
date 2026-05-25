CREATE TABLE "step_milestone_claims" (
  "id" TEXT PRIMARY KEY,
  "user_id" TEXT NOT NULL,
  "claimed_date" TEXT NOT NULL,
  "threshold" INTEGER NOT NULL,
  "coins" INTEGER NOT NULL,
  "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "step_milestone_claims_user_id_fkey"
    FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE CASCADE
);
CREATE UNIQUE INDEX "step_milestone_claims_user_id_claimed_date_threshold_key"
  ON "step_milestone_claims"("user_id", "claimed_date", "threshold");
CREATE INDEX "step_milestone_claims_user_id_claimed_date_idx"
  ON "step_milestone_claims"("user_id", "claimed_date");
