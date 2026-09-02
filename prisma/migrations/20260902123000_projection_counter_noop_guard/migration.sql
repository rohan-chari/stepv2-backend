CREATE OR REPLACE FUNCTION maintain_domain_event_projection_counts()
RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE
  old_terminal integer := 0; new_terminal integer := 0;
  old_failed integer := 0; new_failed integer := 0; parent_id uuid;
BEGIN
  IF TG_OP='UPDATE' AND OLD.status IS NOT DISTINCT FROM NEW.status THEN RETURN NEW; END IF;
  IF TG_OP <> 'INSERT' THEN
    old_terminal := CASE WHEN OLD.status IN ('COMPLETED','SUPPRESSED','FAILED_TERMINAL') THEN 1 ELSE 0 END;
    old_failed := CASE WHEN OLD.status='FAILED_TERMINAL' THEN 1 ELSE 0 END;
  END IF;
  IF TG_OP <> 'DELETE' THEN
    new_terminal := CASE WHEN NEW.status IN ('COMPLETED','SUPPRESSED','FAILED_TERMINAL') THEN 1 ELSE 0 END;
    new_failed := CASE WHEN NEW.status='FAILED_TERMINAL' THEN 1 ELSE 0 END;
  END IF;
  parent_id := COALESCE(NEW.domain_event_id, OLD.domain_event_id);
  UPDATE domain_event_outbox
     SET projection_count=projection_count + CASE WHEN TG_OP='INSERT' THEN 1 WHEN TG_OP='DELETE' THEN -1 ELSE 0 END,
         terminal_projection_count=terminal_projection_count + new_terminal - old_terminal,
         failed_projection_count=failed_projection_count + new_failed - old_failed
   WHERE id=parent_id AND projection_counts_valid_at IS NOT NULL
     AND (TG_OP IN ('INSERT','DELETE') OR new_terminal<>old_terminal OR new_failed<>old_failed);
  RETURN COALESCE(NEW, OLD);
END;
$$;
