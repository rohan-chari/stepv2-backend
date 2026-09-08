-- Serialize admission and later wallet writes without SHARE-lock upgrades.
CREATE OR REPLACE FUNCTION billing_competition_realm_guard() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE realm TEXT; parent_realm TEXT;
BEGIN
  IF TG_OP='UPDATE' THEN
    IF NEW.economic_realm IS DISTINCT FROM OLD.economic_realm THEN
      RAISE EXCEPTION 'BILLING_REALM_IMMUTABLE' USING ERRCODE='23514';
    END IF;
    -- Preserve the stamp on creator deletion; do not recalculate it as production.
    IF NEW.creator_id IS NOT NULL AND NEW.creator_id IS DISTINCT FROM OLD.creator_id THEN
      SELECT billing_realm INTO realm FROM users WHERE id=NEW.creator_id FOR NO KEY UPDATE;
      IF realm IS DISTINCT FROM NEW.economic_realm THEN RAISE EXCEPTION 'BILLING_REALM_MISMATCH' USING ERRCODE='23514'; END IF;
    END IF;
    RETURN NEW;
  END IF;
  IF NEW.creator_id IS NOT NULL THEN
    SELECT billing_realm INTO realm FROM users WHERE id=NEW.creator_id FOR NO KEY UPDATE;
  END IF;
  IF TG_TABLE_NAME='races' THEN
    IF NEW.tournament_id IS NOT NULL THEN
      SELECT economic_realm INTO parent_realm FROM tournaments WHERE id=NEW.tournament_id FOR SHARE;
    END IF;
  END IF;
  IF realm IS NOT NULL AND parent_realm IS NOT NULL AND realm<>parent_realm THEN
    RAISE EXCEPTION 'BILLING_REALM_MISMATCH' USING ERRCODE='23514';
  END IF;
  NEW.economic_realm := COALESCE(parent_realm,realm,'production');
  RETURN NEW;
END $$;

CREATE OR REPLACE FUNCTION billing_admission_realm_guard() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE actor TEXT; target TEXT; other TEXT;
BEGIN
  IF TG_TABLE_NAME='referrals' THEN
    PERFORM id FROM users WHERE id IN (NEW.referee_id,NEW.referrer_id) ORDER BY id FOR NO KEY UPDATE;
  END IF;
  IF TG_TABLE_NAME='race_participants' THEN
    SELECT billing_realm INTO actor FROM users WHERE id=NEW.user_id FOR NO KEY UPDATE;
    SELECT economic_realm INTO target FROM races WHERE id=NEW.race_id FOR SHARE;
  ELSIF TG_TABLE_NAME='tournament_participants' THEN
    SELECT billing_realm INTO actor FROM users WHERE id=NEW.user_id FOR NO KEY UPDATE;
    SELECT economic_realm INTO target FROM tournaments WHERE id=NEW.tournament_id FOR SHARE;
  ELSIF TG_TABLE_NAME='race_join_requests' THEN
    SELECT billing_realm INTO actor FROM users WHERE id=NEW.requester_user_id FOR NO KEY UPDATE;
    SELECT economic_realm INTO target FROM races WHERE id=NEW.race_id FOR SHARE;
  ELSIF TG_TABLE_NAME='race_series_subscriptions' THEN
    SELECT billing_realm INTO actor FROM users WHERE id=NEW.user_id FOR NO KEY UPDATE;
    SELECT r.economic_realm INTO target FROM races r JOIN race_series s ON s.current_race_id=r.id WHERE s.id=NEW.series_id;
  ELSIF TG_TABLE_NAME='referrals' THEN
    SELECT billing_realm INTO actor FROM users WHERE id=NEW.referee_id FOR NO KEY UPDATE;
    SELECT billing_realm INTO other FROM users WHERE id=NEW.referrer_id FOR NO KEY UPDATE;
    target := 'production';
    IF other='sandbox' THEN RAISE EXCEPTION 'BILLING_REALM_MISMATCH' USING ERRCODE='23514'; END IF;
  END IF;
  IF actor IS NOT NULL AND target IS NOT NULL AND actor<>target THEN
    RAISE EXCEPTION 'BILLING_REALM_MISMATCH' USING ERRCODE='23514';
  END IF;
  RETURN NEW;
END $$;

CREATE OR REPLACE FUNCTION billing_production_admission_guard() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE realm TEXT;
BEGIN
  IF NEW.user_id IS NULL THEN RETURN NEW; END IF;
  SELECT billing_realm INTO realm FROM users WHERE id=NEW.user_id FOR NO KEY UPDATE;
  IF realm='sandbox' THEN RAISE EXCEPTION 'BILLING_REALM_MISMATCH' USING ERRCODE='23514'; END IF;
  RETURN NEW;
END $$;
