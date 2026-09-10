-- Deliberately outside a transaction: avoid blocking live effect writes.
CREATE INDEX CONCURRENTLY "race_active_effects_decoy_cooldown_idx"
ON "race_active_effects" ("target_participant_id", "type", "decoy_consumed_at");
