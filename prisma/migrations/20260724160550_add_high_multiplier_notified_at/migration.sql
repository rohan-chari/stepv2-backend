-- AlterTable: additive, nullable — item 6b high-multiplier-alert dedup flag.
ALTER TABLE "race_participants" ADD COLUMN     "high_multiplier_notified_at" TIMESTAMP(3);
