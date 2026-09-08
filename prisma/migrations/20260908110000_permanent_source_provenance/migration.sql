CREATE FUNCTION billing_permanent_source_provenance() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE owner_id TEXT; purchase_time TIMESTAMP(3); product TEXT;
BEGIN
 IF TG_OP='UPDATE' AND (NEW.purchase_id<>OLD.purchase_id OR NEW.identity_id<>OLD.identity_id OR NEW.purchased_at<>OLD.purchased_at) THEN
 RAISE EXCEPTION 'Permanent purchase source is immutable' USING ERRCODE='23514'; END IF;
 SELECT identity_id,purchased_at,product_id INTO owner_id,purchase_time,product FROM billing_purchases WHERE id=NEW.purchase_id;
 IF owner_id IS DISTINCT FROM NEW.identity_id OR purchase_time IS DISTINCT FROM NEW.purchased_at OR product IS DISTINCT FROM 'plus_permanent' THEN
 RAISE EXCEPTION 'Permanent source does not match its verified receipt' USING ERRCODE='23514'; END IF;
 RETURN NEW;
END $$;
CREATE TRIGGER billing_permanent_source_provenance BEFORE INSERT OR UPDATE ON billing_permanent_sources FOR EACH ROW EXECUTE FUNCTION billing_permanent_source_provenance();
