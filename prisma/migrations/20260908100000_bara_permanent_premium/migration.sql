CREATE TABLE billing_permanent_schedules (
 identity_id TEXT PRIMARY KEY REFERENCES billing_identities(id), benefit_version INTEGER NOT NULL DEFAULT 1,
 anchor_at TIMESTAMP(3) NOT NULL, next_period INTEGER NOT NULL DEFAULT 0 CHECK(next_period>=0),
 next_due_at TIMESTAMP(3) NOT NULL, created_at TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP
);
CREATE INDEX billing_permanent_schedules_next_due_at_idx ON billing_permanent_schedules(next_due_at);
CREATE TABLE billing_permanent_sources (
 purchase_id TEXT PRIMARY KEY REFERENCES billing_purchases(id), identity_id TEXT NOT NULL REFERENCES billing_identities(id),
 purchased_at TIMESTAMP(3) NOT NULL, revoked_at TIMESTAMP(3), refund_operation TEXT, observed_at TIMESTAMP(3) NOT NULL
);
CREATE INDEX billing_permanent_sources_identity_id_purchased_at_idx ON billing_permanent_sources(identity_id,purchased_at);
CREATE TABLE billing_permanent_grants (
 id TEXT PRIMARY KEY, identity_id TEXT NOT NULL REFERENCES billing_identities(id), benefit_version INTEGER NOT NULL DEFAULT 1,
 period INTEGER NOT NULL CHECK(period>=0), source_purchase_id TEXT NOT NULL REFERENCES billing_permanent_sources(purchase_id),
 boundary_at TIMESTAMP(3) NOT NULL, coins INTEGER NOT NULL DEFAULT 500 CHECK(coins>=0), credits INTEGER NOT NULL DEFAULT 10 CHECK(credits>=0),
 recovered_coins INTEGER NOT NULL DEFAULT 0 CHECK(recovered_coins>=0), absorbed_coins INTEGER NOT NULL DEFAULT 0 CHECK(absorbed_coins>=0),
 revoked_credits INTEGER NOT NULL DEFAULT 0 CHECK(revoked_credits>=0), refunded_at TIMESTAMP(3), created_at TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
 UNIQUE(identity_id,benefit_version,period)
);
CREATE INDEX billing_permanent_grants_source_purchase_id_idx ON billing_permanent_grants(source_purchase_id);
CREATE TABLE billing_permanent_revocations (
 id TEXT PRIMARY KEY, source_purchase_id TEXT NOT NULL REFERENCES billing_permanent_sources(purchase_id),
 revoked_at TIMESTAMP(3) NOT NULL, observed_at TIMESTAMP(3) NOT NULL, reversed_at TIMESTAMP(3)
);
CREATE INDEX billing_permanent_revocations_source_purchase_id_observed_at_idx ON billing_permanent_revocations(source_purchase_id,observed_at);
CREATE FUNCTION billing_permanent_schedule_immutable() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
 IF NEW.identity_id<>OLD.identity_id OR NEW.benefit_version<>OLD.benefit_version OR NEW.anchor_at<>OLD.anchor_at THEN
 RAISE EXCEPTION 'Permanent schedule identity and anniversary are immutable' USING ERRCODE='23514'; END IF;
 RETURN NEW;
END $$;
CREATE TRIGGER billing_permanent_schedule_immutable BEFORE UPDATE ON billing_permanent_schedules FOR EACH ROW EXECUTE FUNCTION billing_permanent_schedule_immutable();
CREATE FUNCTION billing_permanent_grant_immutable() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
 IF NEW.id<>OLD.id OR NEW.identity_id<>OLD.identity_id OR NEW.benefit_version<>OLD.benefit_version OR NEW.period<>OLD.period OR NEW.source_purchase_id<>OLD.source_purchase_id OR NEW.boundary_at<>OLD.boundary_at OR NEW.coins<>OLD.coins OR NEW.credits<>OLD.credits THEN
 RAISE EXCEPTION 'Permanent reward provenance is immutable' USING ERRCODE='23514'; END IF;
 RETURN NEW;
END $$;
CREATE TRIGGER billing_permanent_grant_immutable BEFORE UPDATE ON billing_permanent_grants FOR EACH ROW EXECUTE FUNCTION billing_permanent_grant_immutable();

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
      OR EXISTS (SELECT 1 FROM billing_permanent_schedules p JOIN billing_identities i ON i.id=p.identity_id WHERE i.user_id=NEW.id)
      OR EXISTS (SELECT 1 FROM billing_permanent_sources p JOIN billing_identities i ON i.id=p.identity_id WHERE i.user_id=NEW.id)
      OR EXISTS (SELECT 1 FROM billing_permanent_grants p JOIN billing_identities i ON i.id=p.identity_id WHERE i.user_id=NEW.id)
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
