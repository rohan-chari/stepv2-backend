-- App-funded prize pools (buy-ins removed).
--
-- Additive and backward-compatible: both columns are NOT NULL with legacy-safe
-- defaults, so every existing row (and the currently-deployed old code, which
-- never writes them) keeps behaving exactly as today. No backfill.
--
--   funded_prize      -> the discriminator between the buy-in model (false) and
--                        the app-minted model (true). The ONLY authority at
--                        settlement, so the two can never both pay.
--   prize_pool_coins  -> the settled pool, stamped at settlement so a completed
--                        competition's prize never drifts afterwards.
ALTER TABLE "races"       ADD COLUMN "funded_prize"     BOOLEAN NOT NULL DEFAULT false;
ALTER TABLE "races"       ADD COLUMN "prize_pool_coins" INTEGER NOT NULL DEFAULT 0;
ALTER TABLE "tournaments" ADD COLUMN "funded_prize"     BOOLEAN NOT NULL DEFAULT false;
ALTER TABLE "tournaments" ADD COLUMN "prize_pool_coins" INTEGER NOT NULL DEFAULT 0;
