CREATE TABLE "powerup_usage_states" (
    "id" TEXT NOT NULL,
    "race_id" TEXT NOT NULL,
    "user_id" TEXT NOT NULL,
    "powerup_type" "PowerupType" NOT NULL,
    "last_used_at" TIMESTAMP(3) NOT NULL,
    "active_until" TIMESTAMP(3),
    "next_usable_at" TIMESTAMP(3) NOT NULL,
    "source_powerup_id" TEXT,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,
    CONSTRAINT "powerup_usage_states_pkey" PRIMARY KEY ("id"),
    CONSTRAINT "powerup_usage_states_race_id_fkey" FOREIGN KEY ("race_id") REFERENCES "races"("id") ON DELETE CASCADE ON UPDATE CASCADE,
    CONSTRAINT "powerup_usage_states_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE
);

CREATE UNIQUE INDEX "powerup_usage_states_race_id_user_id_powerup_type_key" ON "powerup_usage_states"("race_id", "user_id", "powerup_type");
