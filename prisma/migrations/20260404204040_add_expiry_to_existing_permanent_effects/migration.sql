-- Set 24-hour expiry on existing COMPRESSION_SOCKS effects that have no expiry
UPDATE race_active_effects
SET expires_at = starts_at + INTERVAL '24 hours'
WHERE type = 'compression_socks'
  AND status = 'active_effect'
  AND expires_at IS NULL;

-- Set 24-hour expiry on existing FANNY_PACK effects (if any exist without expiry)
UPDATE race_active_effects
SET expires_at = starts_at + INTERVAL '24 hours'
WHERE type = 'fanny_pack'
  AND status = 'active_effect'
  AND expires_at IS NULL;
