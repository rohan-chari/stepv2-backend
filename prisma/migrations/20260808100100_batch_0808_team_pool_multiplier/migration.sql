-- Batch 2026-08-08 item 5: team-race prize pool multiplier.
--
-- Additive + NULLABLE with no backfill, and the null is load-bearing: NULL
-- means "multiplier 1.0", i.e. exactly today's payout formula. Every race that
-- already exists — pending, in-flight, and completed — therefore keeps its
-- current projected AND settled pool to the coin.
--
-- Stored as basis points (Int) rather than a float so the stamp is exact:
-- 1.0 -> 10000, 1.5 -> 15000, 1.875 -> 18750.
--
-- Why stamp at creation instead of reading the env at settlement: the pool is
-- advertised to players throughout the race (buildRaceMoneyView projects it on
-- every read path). Reading a mutable env at settlement would let an ops edit
-- silently reprice a race that already promised a number. The stamp makes an
-- env change apply only to races created after it.
--
-- Old deployed backend code never selects the column; no shipped app binary
-- knows it exists. Payout amounts are server-computed, so no client reads it.

ALTER TABLE "races" ADD COLUMN "team_pool_mult_bps" INTEGER;
