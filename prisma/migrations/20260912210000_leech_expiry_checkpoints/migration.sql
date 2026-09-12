BEGIN;

-- Source checkpoints are maintained in the source write transaction, not by
-- the asynchronously scheduled scorer. Already-expired effects remain legacy.
CREATE TABLE leech_expiry_checkpoints (
  effect_id TEXT NOT NULL REFERENCES race_active_effects(id) ON DELETE CASCADE,
  kind TEXT NOT NULL CHECK (kind IN ('daily', 'bonus', 'hitchhike')),
  race_id TEXT NOT NULL,
  target_participant_id TEXT NOT NULL,
  target_user_id TEXT NOT NULL,
  expires_at TIMESTAMP(3) NOT NULL,
  bonus_steps INTEGER NOT NULL,
  daily_totals JSONB NOT NULL DEFAULT '{}',
  hitchhike_captures JSONB NOT NULL DEFAULT '{}',
  PRIMARY KEY (effect_id, kind)
);
CREATE INDEX leech_expiry_checkpoints_user_expiry_idx
  ON leech_expiry_checkpoints(target_user_id, expires_at);
CREATE INDEX leech_expiry_checkpoints_participant_idx
  ON leech_expiry_checkpoints(target_participant_id);

CREATE FUNCTION initialize_leech_expiry_checkpoint() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF UPPER(NEW.type::text) <> 'LEECH' OR NEW.expires_at IS NULL THEN RETURN NEW; END IF;
  INSERT INTO leech_expiry_checkpoints
    (effect_id, kind, race_id, target_participant_id, target_user_id, expires_at,
     bonus_steps, daily_totals, hitchhike_captures)
  SELECT NEW.id, kinds.kind, NEW.race_id, NEW.target_participant_id, NEW.target_user_id,
    NEW.expires_at, participant.bonus_steps,
    COALESCE((SELECT jsonb_object_agg(day.date::text, day.steps)
      FROM steps day WHERE day.user_id=NEW.target_user_id
        AND day.date >= (race.started_at::date - 1)
        AND day.date <= (NEW.expires_at::date + 1)), '{}'::jsonb),
    COALESCE((SELECT jsonb_object_agg(copy.effect_id, to_jsonb(copy))
      FROM hitchhike_attribution_captures copy
      WHERE copy.race_id=NEW.race_id AND copy.source_user_id=NEW.target_user_id
        AND copy.capture_through <= NEW.expires_at), '{}'::jsonb)
  FROM race_participants participant JOIN races race ON race.id=participant.race_id
  CROSS JOIN (VALUES ('daily'), ('bonus'), ('hitchhike')) kinds(kind)
  WHERE participant.id=NEW.target_participant_id;
  RETURN NEW;
END $$;
CREATE TRIGGER leech_expiry_checkpoint_created AFTER INSERT ON race_active_effects
  FOR EACH ROW EXECUTE FUNCTION initialize_leech_expiry_checkpoint();

CREATE FUNCTION checkpoint_leech_daily_input() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE admitted_at timestamptz := clock_timestamp();
BEGIN
  UPDATE leech_expiry_checkpoints checkpoint
  SET daily_totals=jsonb_set(checkpoint.daily_totals, ARRAY[NEW.date::text], to_jsonb(NEW.steps), true)
  FROM race_active_effects effect JOIN races race ON race.id=effect.race_id
  WHERE checkpoint.kind='daily' AND checkpoint.target_user_id=NEW.user_id
    AND checkpoint.expires_at >= admitted_at
    AND checkpoint.effect_id=effect.id AND effect.expires_at >= admitted_at
    AND NOT (COALESCE(effect.metadata, '{}'::jsonb) ? 'leechFinalV1')
    AND NOT EXISTS (SELECT 1 FROM races terminal_race WHERE terminal_race.id=effect.race_id
      AND terminal_race.ends_at < admitted_at)
    AND NOT EXISTS (SELECT 1 FROM race_participants terminal_person
      WHERE terminal_person.race_id=effect.race_id
        AND (terminal_person.id=effect.target_participant_id OR terminal_person.user_id=effect.source_user_id)
        AND LEAST(terminal_person.finished_at, terminal_person.forfeited_at) < admitted_at)
    AND NEW.date >= (race.started_at::date - 1)
    AND NEW.date <= (effect.expires_at::date + 1);
  RETURN NEW;
END $$;
CREATE TRIGGER leech_daily_input_insert AFTER INSERT ON steps
  FOR EACH ROW EXECUTE FUNCTION checkpoint_leech_daily_input();
CREATE TRIGGER leech_daily_input_update AFTER UPDATE OF steps ON steps
  FOR EACH ROW WHEN (OLD.steps IS DISTINCT FROM NEW.steps)
  EXECUTE FUNCTION checkpoint_leech_daily_input();

CREATE FUNCTION checkpoint_leech_bonus_input() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE admitted_at timestamptz := clock_timestamp();
BEGIN
  UPDATE leech_expiry_checkpoints checkpoint SET bonus_steps=NEW.bonus_steps
  FROM race_active_effects effect
  WHERE checkpoint.kind='bonus' AND checkpoint.target_participant_id=NEW.id
    AND checkpoint.expires_at >= admitted_at
    AND checkpoint.effect_id=effect.id AND effect.expires_at >= admitted_at
    AND NOT (COALESCE(effect.metadata, '{}'::jsonb) ? 'leechFinalV1')
    AND NOT EXISTS (SELECT 1 FROM races terminal_race WHERE terminal_race.id=effect.race_id
      AND terminal_race.ends_at < admitted_at)
    AND NOT EXISTS (SELECT 1 FROM race_participants terminal_person
      WHERE terminal_person.race_id=effect.race_id
        AND (terminal_person.id=effect.target_participant_id OR terminal_person.user_id=effect.source_user_id)
        AND LEAST(terminal_person.finished_at, terminal_person.forfeited_at) < admitted_at);
  RETURN NEW;
END $$;
CREATE TRIGGER leech_bonus_input_update AFTER UPDATE OF bonus_steps ON race_participants
  FOR EACH ROW WHEN (OLD.bonus_steps IS DISTINCT FROM NEW.bonus_steps)
  EXECUTE FUNCTION checkpoint_leech_bonus_input();

CREATE FUNCTION checkpoint_leech_hitchhike_input() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE admitted_at timestamptz := clock_timestamp();
BEGIN
  UPDATE leech_expiry_checkpoints checkpoint
  SET hitchhike_captures=jsonb_set(checkpoint.hitchhike_captures,
    ARRAY[NEW.effect_id], to_jsonb(NEW), true)
  FROM race_active_effects effect
  WHERE checkpoint.kind='hitchhike' AND checkpoint.target_user_id=NEW.source_user_id AND checkpoint.race_id=NEW.race_id
    AND checkpoint.expires_at >= admitted_at
    AND checkpoint.effect_id=effect.id AND effect.expires_at >= admitted_at
    AND NOT (COALESCE(effect.metadata, '{}'::jsonb) ? 'leechFinalV1')
    AND NOT EXISTS (SELECT 1 FROM races terminal_race WHERE terminal_race.id=effect.race_id
      AND terminal_race.ends_at < admitted_at)
    AND NOT EXISTS (SELECT 1 FROM race_participants terminal_person
      WHERE terminal_person.race_id=effect.race_id
        AND (terminal_person.id=effect.target_participant_id OR terminal_person.user_id=effect.source_user_id)
        AND LEAST(terminal_person.finished_at, terminal_person.forfeited_at) < admitted_at)
    AND NEW.capture_through <= effect.expires_at;
  RETURN NEW;
END $$;
CREATE TRIGGER leech_hitchhike_input AFTER INSERT OR UPDATE ON hitchhike_attribution_captures
  FOR EACH ROW EXECUTE FUNCTION checkpoint_leech_hitchhike_input();

-- Even an older writer replacing unrelated effect metadata must retain the
-- winning final transfer. Zero is a resolved value, not an absent stamp.
CREATE FUNCTION preserve_leech_final_transfer() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF OLD.metadata ? 'leechFinalV1' THEN
    NEW.metadata=jsonb_set(COALESCE(NEW.metadata, '{}'::jsonb),
      '{leechFinalV1}', OLD.metadata->'leechFinalV1', true);
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER immutable_leech_final_transfer BEFORE UPDATE OF metadata ON race_active_effects
  FOR EACH ROW EXECUTE FUNCTION preserve_leech_final_transfer();

-- Initialize only effects still live at migration. Expired legacy transfers are
-- frozen from their current allocation by the application, without reconstruction.
INSERT INTO leech_expiry_checkpoints
  (effect_id, kind, race_id, target_participant_id, target_user_id, expires_at,
   bonus_steps, daily_totals, hitchhike_captures)
SELECT effect.id, kinds.kind, effect.race_id, effect.target_participant_id,
  effect.target_user_id, effect.expires_at,
  CASE WHEN kinds.kind='bonus' THEN participant.bonus_steps ELSE 0 END,
  CASE WHEN kinds.kind='daily' THEN COALESCE((SELECT jsonb_object_agg(day.date::text, day.steps)
    FROM steps day WHERE day.user_id=effect.target_user_id
      AND day.date >= race.started_at::date - 1 AND day.date <= effect.expires_at::date + 1), '{}'::jsonb)
    ELSE '{}'::jsonb END,
  CASE WHEN kinds.kind='hitchhike' THEN COALESCE((SELECT jsonb_object_agg(copy.effect_id, to_jsonb(copy))
    FROM hitchhike_attribution_captures copy WHERE copy.race_id=effect.race_id
      AND copy.source_user_id=effect.target_user_id AND copy.capture_through<=effect.expires_at), '{}'::jsonb)
    ELSE '{}'::jsonb END
FROM race_active_effects effect
JOIN race_participants participant ON participant.id=effect.target_participant_id
JOIN races race ON race.id=effect.race_id
CROSS JOIN (VALUES ('daily'), ('bonus'), ('hitchhike')) kinds(kind)
WHERE UPPER(effect.type::text)='LEECH' AND effect.expires_at > clock_timestamp()
  AND race.ends_at > clock_timestamp() AND UPPER(race.status::text)='ACTIVE'
  AND NOT (COALESCE(effect.metadata, '{}'::jsonb) ? 'leechFinalV1')
  AND NOT EXISTS (SELECT 1 FROM race_participants terminal_person
    WHERE terminal_person.race_id=effect.race_id
      AND (terminal_person.id=effect.target_participant_id OR terminal_person.user_id=effect.source_user_id)
      AND (terminal_person.finished_at IS NOT NULL OR terminal_person.forfeited_at IS NOT NULL))
ON CONFLICT DO NOTHING;

COMMIT;
