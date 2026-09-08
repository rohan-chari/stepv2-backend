-- Separate economic admission from routine users-row metadata/wallet locks.
-- Namespace 1700090719 is permanent coordination; hash collisions only cause
-- conservative conversion retries. Admissions hold shared locks until commit.
CREATE FUNCTION billing_read_realm(actor_id TEXT) RETURNS TEXT LANGUAGE plpgsql VOLATILE AS $$
DECLARE realm TEXT;
BEGIN
  IF current_setting('transaction_isolation') NOT IN ('read committed','read uncommitted') THEN
    RAISE EXCEPTION 'BILLING_REALM_RETRY_ISOLATION' USING ERRCODE='40001';
  END IF;
  PERFORM pg_advisory_xact_lock_shared(1700090719,hashtext(actor_id));
  -- A separate query in this VOLATILE function gets a fresh READ COMMITTED
  -- snapshot after any concurrent conversion commits and releases its lock.
  SELECT billing_realm INTO realm FROM users WHERE id=actor_id;
  RETURN realm;
END $$;

CREATE OR REPLACE FUNCTION billing_user_realm_guard() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE apple_hash TEXT; google_hash TEXT;
BEGIN
  apple_hash := encode(sha256(convert_to('apple:' || NEW.apple_id,'UTF8')),'hex');
  google_hash := encode(sha256(convert_to('google:' || NEW.google_sub,'UTF8')),'hex');
  IF TG_OP = 'INSERT' AND current_setting('transaction_isolation') NOT IN ('read committed','read uncommitted') THEN
    RAISE EXCEPTION 'BILLING_REALM_RETRY_ISOLATION' USING ERRCODE='40001';
  END IF;
  IF TG_OP = 'INSERT' AND EXISTS (SELECT 1 FROM billing_sandbox_auth_identities WHERE identity_hash IN (apple_hash,google_hash)) THEN
    NEW.billing_realm := 'sandbox';
  END IF;
  IF TG_OP = 'UPDATE' AND NEW.billing_realm IS DISTINCT FROM OLD.billing_realm THEN
    IF current_setting('transaction_isolation') NOT IN ('read committed','read uncommitted') THEN
      RAISE EXCEPTION 'BILLING_REALM_RETRY_ISOLATION' USING ERRCODE='40001';
    END IF;
    -- UPDATE already owns a users row lock. Never wait here: an admission may
    -- need that row for its wallet after taking the shared advisory lock.
    IF NOT pg_try_advisory_xact_lock(1700090719,hashtext(NEW.id)) THEN
      RAISE EXCEPTION 'BILLING_REALM_BUSY' USING ERRCODE='40001';
    END IF;
    IF OLD.billing_realm = 'sandbox' OR NEW.billing_realm <> 'sandbox' OR OLD.coins <> 0
      OR EXISTS (SELECT 1 FROM coin_transactions WHERE user_id=NEW.id)
      OR EXISTS (SELECT 1 FROM race_participants WHERE user_id=NEW.id)
      OR EXISTS (SELECT 1 FROM tournament_participants WHERE user_id=NEW.id)
      OR EXISTS (SELECT 1 FROM races WHERE creator_id=NEW.id)
      OR EXISTS (SELECT 1 FROM tournaments WHERE creator_id=NEW.id)
      OR EXISTS (SELECT 1 FROM referrals WHERE referrer_id=NEW.id OR referee_id=NEW.id)
      OR EXISTS (SELECT 1 FROM race_series_subscriptions WHERE user_id=NEW.id)
      OR EXISTS (SELECT 1 FROM race_join_requests WHERE requester_user_id=NEW.id)
      OR EXISTS (SELECT 1 FROM seeded_race_bucket_assignments WHERE user_id=NEW.id)
      OR EXISTS (SELECT 1 FROM seeded_race_window_memberships WHERE user_id=NEW.id)
      OR EXISTS (SELECT 1 FROM season_scores WHERE user_id=NEW.id)
      OR EXISTS (SELECT 1 FROM ranked_cohort_members WHERE user_id=NEW.id)
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

CREATE OR REPLACE FUNCTION billing_competition_realm_guard() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE realm TEXT; parent_realm TEXT;
BEGIN
  IF TG_OP='UPDATE' THEN
    IF NEW.economic_realm IS DISTINCT FROM OLD.economic_realm THEN
      RAISE EXCEPTION 'BILLING_REALM_IMMUTABLE' USING ERRCODE='23514';
    END IF;
    -- Preserve the stamp on creator deletion; do not recalculate it as production.
    IF NEW.creator_id IS NOT NULL AND NEW.creator_id IS DISTINCT FROM OLD.creator_id THEN
      realm := billing_read_realm(NEW.creator_id);
      IF realm IS DISTINCT FROM NEW.economic_realm THEN RAISE EXCEPTION 'BILLING_REALM_MISMATCH' USING ERRCODE='23514'; END IF;
    END IF;
    RETURN NEW;
  END IF;
  IF NEW.creator_id IS NOT NULL THEN
    realm := billing_read_realm(NEW.creator_id);
  END IF;
  IF TG_TABLE_NAME='races' THEN
    IF NEW.tournament_id IS NOT NULL THEN
      SELECT economic_realm INTO parent_realm FROM tournaments WHERE id=NEW.tournament_id;
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
  IF TG_TABLE_NAME='race_participants' THEN
    actor := billing_read_realm(NEW.user_id);
    SELECT economic_realm INTO target FROM races WHERE id=NEW.race_id;
  ELSIF TG_TABLE_NAME='tournament_participants' THEN
    actor := billing_read_realm(NEW.user_id);
    SELECT economic_realm INTO target FROM tournaments WHERE id=NEW.tournament_id;
  ELSIF TG_TABLE_NAME='race_join_requests' THEN
    actor := billing_read_realm(NEW.requester_user_id);
    SELECT economic_realm INTO target FROM races WHERE id=NEW.race_id;
  ELSIF TG_TABLE_NAME='race_series_subscriptions' THEN
    actor := billing_read_realm(NEW.user_id);
    SELECT r.economic_realm INTO target FROM races r JOIN race_series s ON s.current_race_id=r.id WHERE s.id=NEW.series_id;
  ELSIF TG_TABLE_NAME='referrals' THEN
    actor := billing_read_realm(NEW.referee_id);
    other := billing_read_realm(NEW.referrer_id);
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
  realm := billing_read_realm(NEW.user_id);
  IF realm='sandbox' THEN RAISE EXCEPTION 'BILLING_REALM_MISMATCH' USING ERRCODE='23514'; END IF;
  RETURN NEW;
END $$;

CREATE OR REPLACE FUNCTION billing_friendship_realm_guard() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE requester_realm TEXT; addressee_realm TEXT;
BEGIN
  requester_realm := billing_read_realm(NEW.requester_id);
  addressee_realm := billing_read_realm(NEW.addressee_id);
  IF requester_realm IS NOT NULL AND addressee_realm IS NOT NULL AND requester_realm<>addressee_realm THEN
    RAISE EXCEPTION 'BILLING_REALM_MISMATCH' USING ERRCODE='23514';
  END IF;
  RETURN NEW;
END $$;
