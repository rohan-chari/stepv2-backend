-- Permanent economic domains, not a release control. Frozen writers default to production.
ALTER TABLE users ADD COLUMN billing_realm TEXT NOT NULL DEFAULT 'production';
ALTER TABLE races ADD COLUMN economic_realm TEXT NOT NULL DEFAULT 'production';
ALTER TABLE tournaments ADD COLUMN economic_realm TEXT NOT NULL DEFAULT 'production';
ALTER TABLE users ADD CONSTRAINT billing_realm_valid CHECK (billing_realm IN ('production','sandbox'));
ALTER TABLE races ADD CONSTRAINT race_realm_valid CHECK (economic_realm IN ('production','sandbox'));
ALTER TABLE tournaments ADD CONSTRAINT tournament_realm_valid CHECK (economic_realm IN ('production','sandbox'));
CREATE TABLE billing_sandbox_auth_identities (
  identity_hash TEXT PRIMARY KEY,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE FUNCTION billing_user_realm_guard() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE apple_hash TEXT; google_hash TEXT;
BEGIN
  apple_hash := encode(sha256(convert_to('apple:' || NEW.apple_id,'UTF8')),'hex');
  google_hash := encode(sha256(convert_to('google:' || NEW.google_sub,'UTF8')),'hex');
  IF TG_OP = 'INSERT' AND EXISTS (SELECT 1 FROM billing_sandbox_auth_identities WHERE identity_hash IN (apple_hash,google_hash)) THEN
    NEW.billing_realm := 'sandbox';
  END IF;
  IF TG_OP = 'UPDATE' AND NEW.billing_realm IS DISTINCT FROM OLD.billing_realm THEN
    IF OLD.billing_realm = 'sandbox' OR NEW.billing_realm <> 'sandbox' OR OLD.coins <> 0
      OR EXISTS (SELECT 1 FROM coin_transactions WHERE user_id=NEW.id)
      OR EXISTS (SELECT 1 FROM race_participants WHERE user_id=NEW.id)
      OR EXISTS (SELECT 1 FROM tournament_participants WHERE user_id=NEW.id)
      OR EXISTS (SELECT 1 FROM races WHERE creator_id=NEW.id)
      OR EXISTS (SELECT 1 FROM tournaments WHERE creator_id=NEW.id)
      OR EXISTS (SELECT 1 FROM referrals WHERE referrer_id=NEW.id OR referee_id=NEW.id)
      OR EXISTS (SELECT 1 FROM friendships WHERE requester_id=NEW.id OR addressee_id=NEW.id)
      OR EXISTS (SELECT 1 FROM giveaway_entrants WHERE user_id=NEW.id)
      OR EXISTS (SELECT 1 FROM billing_purchases p JOIN billing_identities i ON i.id=p.identity_id WHERE i.user_id=NEW.id)
      OR EXISTS (SELECT 1 FROM billing_subscriptions s JOIN billing_identities i ON i.id=s.identity_id WHERE i.user_id=NEW.id)
      OR EXISTS (SELECT 1 FROM billing_credit_lots l JOIN billing_identities i ON i.id=l.identity_id WHERE i.user_id=NEW.id)
      OR EXISTS (SELECT 1 FROM billing_reroll_operations WHERE user_id=NEW.id)
    THEN RAISE EXCEPTION 'BILLING_REALM_IMMUTABLE' USING ERRCODE='23514'; END IF;
    -- An empty identity may already exist from login bootstrap. No receipt is moved.
    UPDATE billing_identities SET environment='sandbox' WHERE user_id=NEW.id;
  END IF;
  IF NEW.billing_realm='sandbox' THEN
    NEW.is_review_account := true;
    NEW.auto_join_featured_races := false;
    INSERT INTO billing_sandbox_auth_identities(identity_hash)
      SELECT h FROM unnest(ARRAY[apple_hash,google_hash]) h WHERE h IS NOT NULL ON CONFLICT DO NOTHING;
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER billing_user_realm BEFORE INSERT OR UPDATE ON users FOR EACH ROW EXECUTE FUNCTION billing_user_realm_guard();

CREATE FUNCTION billing_competition_realm_guard() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE realm TEXT; parent_realm TEXT;
BEGIN
  IF TG_OP='UPDATE' THEN
    IF NEW.economic_realm IS DISTINCT FROM OLD.economic_realm THEN
      RAISE EXCEPTION 'BILLING_REALM_IMMUTABLE' USING ERRCODE='23514';
    END IF;
    -- Preserve the stamp on creator deletion; do not recalculate it as production.
    IF NEW.creator_id IS NOT NULL AND NEW.creator_id IS DISTINCT FROM OLD.creator_id THEN
      SELECT billing_realm INTO realm FROM users WHERE id=NEW.creator_id FOR SHARE;
      IF realm IS DISTINCT FROM NEW.economic_realm THEN RAISE EXCEPTION 'BILLING_REALM_MISMATCH' USING ERRCODE='23514'; END IF;
    END IF;
    RETURN NEW;
  END IF;
  IF NEW.creator_id IS NOT NULL THEN
    SELECT billing_realm INTO realm FROM users WHERE id=NEW.creator_id FOR SHARE;
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
CREATE TRIGGER billing_race_realm BEFORE INSERT OR UPDATE OF economic_realm,creator_id ON races FOR EACH ROW EXECUTE FUNCTION billing_competition_realm_guard();
CREATE TRIGGER billing_tournament_realm BEFORE INSERT OR UPDATE OF economic_realm,creator_id ON tournaments FOR EACH ROW EXECUTE FUNCTION billing_competition_realm_guard();

CREATE FUNCTION billing_admission_realm_guard() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE actor TEXT; target TEXT; other TEXT;
BEGIN
  IF TG_TABLE_NAME='race_participants' THEN
    SELECT billing_realm INTO actor FROM users WHERE id=NEW.user_id FOR SHARE;
    SELECT economic_realm INTO target FROM races WHERE id=NEW.race_id FOR SHARE;
  ELSIF TG_TABLE_NAME='tournament_participants' THEN
    SELECT billing_realm INTO actor FROM users WHERE id=NEW.user_id FOR SHARE;
    SELECT economic_realm INTO target FROM tournaments WHERE id=NEW.tournament_id FOR SHARE;
  ELSIF TG_TABLE_NAME='race_join_requests' THEN
    SELECT billing_realm INTO actor FROM users WHERE id=NEW.requester_user_id FOR SHARE;
    SELECT economic_realm INTO target FROM races WHERE id=NEW.race_id FOR SHARE;
  ELSIF TG_TABLE_NAME='race_series_subscriptions' THEN
    SELECT billing_realm INTO actor FROM users WHERE id=NEW.user_id FOR SHARE;
    SELECT r.economic_realm INTO target FROM races r JOIN race_series s ON s.current_race_id=r.id WHERE s.id=NEW.series_id;
  ELSIF TG_TABLE_NAME='referrals' THEN
    SELECT billing_realm INTO actor FROM users WHERE id=NEW.referee_id FOR SHARE;
    SELECT billing_realm INTO other FROM users WHERE id=NEW.referrer_id FOR SHARE;
    target := 'production';
    IF other='sandbox' THEN RAISE EXCEPTION 'BILLING_REALM_MISMATCH' USING ERRCODE='23514'; END IF;
  END IF;
  IF actor IS NOT NULL AND target IS NOT NULL AND actor<>target THEN
    RAISE EXCEPTION 'BILLING_REALM_MISMATCH' USING ERRCODE='23514';
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER billing_race_admission BEFORE INSERT OR UPDATE OF user_id,race_id ON race_participants FOR EACH ROW EXECUTE FUNCTION billing_admission_realm_guard();
CREATE TRIGGER billing_tournament_admission BEFORE INSERT OR UPDATE OF user_id,tournament_id ON tournament_participants FOR EACH ROW EXECUTE FUNCTION billing_admission_realm_guard();
CREATE TRIGGER billing_join_request_admission BEFORE INSERT OR UPDATE OF requester_user_id,race_id ON race_join_requests FOR EACH ROW EXECUTE FUNCTION billing_admission_realm_guard();
CREATE TRIGGER billing_series_admission BEFORE INSERT OR UPDATE OF user_id,series_id ON race_series_subscriptions FOR EACH ROW EXECUTE FUNCTION billing_admission_realm_guard();
CREATE TRIGGER billing_referral_admission BEFORE INSERT OR UPDATE OF referee_id,referrer_id ON referrals FOR EACH ROW EXECUTE FUNCTION billing_admission_realm_guard();
