-- Close conversion races in production-only competitions and pending enrollment.
CREATE OR REPLACE FUNCTION billing_user_realm_guard() RETURNS trigger LANGUAGE plpgsql AS $$
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

CREATE FUNCTION billing_production_admission_guard() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE realm TEXT;
BEGIN
  IF NEW.user_id IS NULL THEN RETURN NEW; END IF;
  SELECT billing_realm INTO realm FROM users WHERE id=NEW.user_id FOR SHARE;
  IF realm='sandbox' THEN RAISE EXCEPTION 'BILLING_REALM_MISMATCH' USING ERRCODE='23514'; END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER billing_giveaway_admission BEFORE INSERT OR UPDATE OF user_id ON giveaway_entrants FOR EACH ROW EXECUTE FUNCTION billing_production_admission_guard();
CREATE TRIGGER billing_season_admission BEFORE INSERT OR UPDATE OF user_id ON season_scores FOR EACH ROW EXECUTE FUNCTION billing_production_admission_guard();
CREATE TRIGGER billing_ranked_admission BEFORE INSERT OR UPDATE OF user_id ON ranked_cohort_members FOR EACH ROW EXECUTE FUNCTION billing_production_admission_guard();
CREATE TRIGGER billing_seeded_assignment_admission BEFORE INSERT OR UPDATE OF user_id ON seeded_race_bucket_assignments FOR EACH ROW EXECUTE FUNCTION billing_production_admission_guard();
CREATE TRIGGER billing_seeded_membership_admission BEFORE INSERT OR UPDATE OF user_id ON seeded_race_window_memberships FOR EACH ROW EXECUTE FUNCTION billing_production_admission_guard();
