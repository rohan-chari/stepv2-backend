-- Prevent social auto-linking from connecting sandbox purchases to real players.
CREATE FUNCTION billing_friendship_realm_guard() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE requester_realm TEXT; addressee_realm TEXT;
BEGIN
  PERFORM id FROM users WHERE id IN (NEW.requester_id,NEW.addressee_id) ORDER BY id FOR NO KEY UPDATE;
  SELECT billing_realm INTO requester_realm FROM users WHERE id=NEW.requester_id;
  SELECT billing_realm INTO addressee_realm FROM users WHERE id=NEW.addressee_id;
  IF requester_realm IS NOT NULL AND addressee_realm IS NOT NULL AND requester_realm<>addressee_realm THEN
    RAISE EXCEPTION 'BILLING_REALM_MISMATCH' USING ERRCODE='23514';
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER billing_friendship_admission BEFORE INSERT OR UPDATE OF requester_id,addressee_id ON friendships FOR EACH ROW EXECUTE FUNCTION billing_friendship_realm_guard();
