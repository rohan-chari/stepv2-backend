-- Mark score-changing effect boundaries that predate this rollout so enabling
-- active-race notices cannot backfill them. Rows whose stored boundary is still
-- in the future are intentionally untouched: status-only resets may mark those
-- EXPIRED before their scoring window actually closes.
UPDATE "race_active_effects"
SET "metadata" = COALESCE("metadata", '{}'::jsonb)
  || '{"activeImpactResolutionSkippedVersion":1}'::jsonb
WHERE "status" = 'expired_effect'
  AND "expires_at" IS NOT NULL
  AND "expires_at" <= CURRENT_TIMESTAMP
  AND "type" IN (
    'leg_cramp',
    'quicksand',
    'runners_high',
    'wrong_turn',
    'campfire_rest',
    'rainstorm',
    'uprising',
    'rally_flag',
    'coin_flip',
    'ghost_pepper',
    'umbrella',
    'drill_sergeant',
    'leech',
    'hitchhike'
  );
