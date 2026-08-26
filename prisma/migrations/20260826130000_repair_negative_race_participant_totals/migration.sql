-- Idempotent aggregate invariant repair. A negative stored total represents an
-- old unapplied penalty remainder; returning it to bonus_steps discards that
-- remainder so it cannot punish future walking. This deliberately touches no
-- placements, payouts, coin ledger rows, or completion state.
UPDATE "race_participants"
   SET "bonus_steps" = "bonus_steps" + (0 - "total_steps"),
       "total_steps" = 0,
       "totals_updated_at" = CURRENT_TIMESTAMP
 WHERE "total_steps" < 0;
