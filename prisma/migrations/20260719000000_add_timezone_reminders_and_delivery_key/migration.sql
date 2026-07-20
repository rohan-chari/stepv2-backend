-- Notification reminders + daily-reward reminder scheduler support.
-- All additive: nullable columns and a defaulted boolean; backfills null/true.
-- Old app binaries are unaffected (they neither read nor write these).

-- AlterTable: users gains a sticky-written IANA timezone and the daily-reward
-- reminder opt-out (defaults true so existing rows keep the reminder on).
ALTER TABLE "users"
  ADD COLUMN "timezone" TEXT,
  ADD COLUMN "daily_reward_reminders_enabled" BOOLEAN NOT NULL DEFAULT true;

-- AlterTable: notifications gains the cross-process atomic-claim key for the
-- daily-reward reminder scheduler. Null for every existing/other writer.
ALTER TABLE "notifications"
  ADD COLUMN "delivery_key" TEXT;

-- CreateIndex: first index on users. Backs the scheduler's zone selection
-- (WHERE timezone IN (...)).
CREATE INDEX "users_timezone_idx" ON "users"("timezone");

-- CreateIndex: PARTIAL unique index on the delivery key. The name matches the
-- Prisma-default name for the `@unique` declared on Notification.deliveryKey, so
-- Prisma's shadow-DB diff sees no drift; the WHERE predicate keeps the index off
-- the (many) null rows and enforces uniqueness only for real claim keys.
-- Postgres already treats nulls as distinct, so null writers never collide.
CREATE UNIQUE INDEX "notifications_delivery_key_key" ON "notifications"("delivery_key") WHERE "delivery_key" IS NOT NULL;
