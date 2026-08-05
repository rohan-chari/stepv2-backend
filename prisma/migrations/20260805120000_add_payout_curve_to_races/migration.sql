-- Seeded challenge top-heavy payouts (§4.4).
--
-- Additive + NULLABLE with no backfill: every existing row keeps NULL, which
-- means "split a graded funded preset EVENLY" — exactly today's behaviour for
-- in-flight, completed, and user-created races alike. Only createSeededRace
-- ever writes it, and only with "GEOMETRIC". Old backend code running against
-- the migrated schema during a pm2 reload simply never reads the column.

ALTER TABLE "races" ADD COLUMN "payout_curve" TEXT;
