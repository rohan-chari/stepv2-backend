-- Serialize active-impact boundary eligibility with the rollout flag itself.
-- The internal epoch is not a public feature flag; it is the durable cutoff
-- used to reject sources whose boundary crossed before the latest enable.
INSERT INTO "app_settings" ("key", "value", "updated_at")
VALUES ('apiActiveImpactNoticesV1Enabled', 'false'::jsonb, CURRENT_TIMESTAMP)
ON CONFLICT ("key") DO NOTHING;

INSERT INTO "app_settings" ("key", "value", "updated_at")
VALUES (
  'apiActiveImpactNoticesV1EnabledFrom',
  to_jsonb(CURRENT_TIMESTAMP::text),
  CURRENT_TIMESTAMP
)
ON CONFLICT ("key") DO NOTHING;
