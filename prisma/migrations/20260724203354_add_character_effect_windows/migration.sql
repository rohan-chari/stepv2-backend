-- CreateTable
CREATE TABLE "character_effect_windows" (
    "id" TEXT NOT NULL,
    "user_id" TEXT NOT NULL,
    "animal" TEXT NOT NULL,
    "multiplier" DOUBLE PRECISION NOT NULL DEFAULT 3,
    "starts_at" TIMESTAMP(3) NOT NULL,
    "ends_at" TIMESTAMP(3) NOT NULL,
    "local_day_key" TEXT NOT NULL,
    "slot" INTEGER NOT NULL,
    "notified_at" TIMESTAMP(3),
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "character_effect_windows_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "character_effect_windows_user_id_starts_at_ends_at_idx" ON "character_effect_windows"("user_id", "starts_at", "ends_at");

-- CreateIndex
CREATE UNIQUE INDEX "character_effect_windows_user_id_local_day_key_slot_key" ON "character_effect_windows"("user_id", "local_day_key", "slot");

-- AddForeignKey
ALTER TABLE "character_effect_windows" ADD CONSTRAINT "character_effect_windows_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;
