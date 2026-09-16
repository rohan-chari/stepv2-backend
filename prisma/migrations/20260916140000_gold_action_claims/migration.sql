CREATE TABLE "gold_action_claims" (
  "id" TEXT NOT NULL,
  "user_id" TEXT NOT NULL,
  "action" TEXT NOT NULL,
  "local_date" TEXT NOT NULL,
  "result_json" JSONB,
  "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updated_at" TIMESTAMP(3) NOT NULL,

  CONSTRAINT "gold_action_claims_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "gold_action_claims_user_id_action_local_date_key"
  ON "gold_action_claims"("user_id", "action", "local_date");
CREATE INDEX "gold_action_claims_action_local_date_idx"
  ON "gold_action_claims"("action", "local_date");

ALTER TABLE "gold_action_claims"
  ADD CONSTRAINT "gold_action_claims_user_id_fkey"
  FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;
