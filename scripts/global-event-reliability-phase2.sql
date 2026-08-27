\set ON_ERROR_STOP on

-- Explicit post-census data phase. Not part of migrate deploy because these
-- indexes must be built concurrently after bounded quarantine/audit is clean.
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1
      FROM global_step_event_generation_state state
     WHERE state.id=1
       AND state.quarantine_started_at IS NOT NULL
       AND state.ready_since IS NOT NULL
       AND state.ready_since <= CURRENT_TIMESTAMP - interval '90 seconds'
       AND (SELECT count(*) FROM global_step_event_cron_owners owner
             WHERE owner.expires_at > CURRENT_TIMESTAMP) = 4
       AND (SELECT count(DISTINCT owner.logical_owner_id)
              FROM global_step_event_cron_owners owner
             WHERE owner.expires_at > CURRENT_TIMESTAMP
               AND owner.logical_owner_id IN ('http:0','http:1','resolution:0','cron:0')
               AND owner.generation >= 2
               AND owner.capabilities @> '["SCHEDULED_EVENT_CONSUMER","UNIVERSAL_C0_LOCK_ORDER","TOKEN_LIFECYCLE","TARGET_AWARE_SENDER","RECONCILER_OWNERSHIP"]'::jsonb) = 4
  ) THEN
    RAISE EXCEPTION 'generation-2 quarantine phase has not started';
  END IF;
  IF EXISTS (SELECT 1 FROM device_tokens WHERE status IS NULL) THEN
    RAISE EXCEPTION 'device token null-status backfill is incomplete';
  END IF;
  IF EXISTS (SELECT 1 FROM device_tokens WHERE status='ACTIVE'
              GROUP BY platform, token HAVING count(*) > 1) THEN
    RAISE EXCEPTION 'active provider-token ownership conflicts remain';
  END IF;
  IF EXISTS (SELECT 1 FROM device_tokens
              WHERE status='ACTIVE' AND installation_id IS NOT NULL
              GROUP BY platform, installation_id HAVING count(*) > 1) THEN
    RAISE EXCEPTION 'active installation ownership conflicts remain';
  END IF;
  IF EXISTS (SELECT 1 FROM device_tokens WHERE status='ACTIVE'
              GROUP BY user_id HAVING count(*) > 10) THEN
    RAISE EXCEPTION 'active installation cap violations remain';
  END IF;
END $$;

CREATE UNIQUE INDEX CONCURRENTLY IF NOT EXISTS "device_tokens_active_provider_token_key"
  ON "device_tokens"("platform", "token") WHERE "status"='ACTIVE';
CREATE UNIQUE INDEX CONCURRENTLY IF NOT EXISTS "device_tokens_active_installation_key"
  ON "device_tokens"("platform", "installation_id")
  WHERE "status"='ACTIVE' AND "installation_id" IS NOT NULL;
