-- Additive, mixed-version-safe durable queue metadata. No payload or history is
-- removed by this migration.
ALTER TABLE "global_event_summary_work"
  ADD COLUMN "ready_at" TIMESTAMP(3),
  ADD COLUMN "next_recovery_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP;

ALTER TABLE "domain_event_outbox"
  ADD COLUMN "projection_count" INTEGER,
  ADD COLUMN "terminal_projection_count" INTEGER,
  ADD COLUMN "failed_projection_count" INTEGER,
  ADD COLUMN "projection_counts_valid_at" TIMESTAMP(3);

CREATE TABLE "domain_event_receipts" (
  "event_key" VARCHAR(255) NOT NULL,
  "domain_event_id" UUID NOT NULL,
  "event_type" VARCHAR(96) NOT NULL,
  "schema_version" INTEGER NOT NULL,
  "aggregate_type" VARCHAR(96) NOT NULL,
  "aggregate_id" TEXT NOT NULL,
  "occurred_at" TIMESTAMP(3) NOT NULL,
  "available_at" TIMESTAMP(3) NOT NULL,
  "envelope_digest" CHAR(64),
  "receipt_state" VARCHAR(16) NOT NULL,
  "digest_version" SMALLINT NOT NULL,
  "terminal_status" VARCHAR(32),
  "completed_at" TIMESTAMP(3),
  "replay_source_type" VARCHAR(64) NOT NULL,
  "replay_source_id" TEXT NOT NULL,
  "finalized_at" TIMESTAMP(3),
  "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updated_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "domain_event_receipts_pkey" PRIMARY KEY ("event_key"),
  CONSTRAINT "domain_event_receipts_domain_event_id_key" UNIQUE ("domain_event_id"),
  CONSTRAINT "domain_event_receipts_state_check" CHECK (
    ("receipt_state"='PROVISIONAL' AND "envelope_digest" IS NULL AND "finalized_at" IS NULL)
    OR ("receipt_state"='FINAL' AND "envelope_digest" IS NOT NULL AND "finalized_at" IS NOT NULL)
  )
);

CREATE TABLE "notification_schedule_receipts" (
  "recipient_user_id" TEXT NOT NULL,
  "delivery_key" TEXT NOT NULL,
  "source_kind" VARCHAR(16) NOT NULL,
  "source_type" VARCHAR(64),
  "source_id" TEXT,
  "source_revision" INTEGER,
  "terminal_status" VARCHAR(32),
  "completed_at" TIMESTAMP(3),
  "direct_retain_until" TIMESTAMP(3),
  "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updated_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "notification_schedule_receipts_pkey" PRIMARY KEY ("recipient_user_id", "delivery_key"),
  CONSTRAINT "notification_schedule_receipts_user_fkey" FOREIGN KEY ("recipient_user_id")
    REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE,
  CONSTRAINT "notification_schedule_receipts_shape_check" CHECK (
    ("source_kind"='SOURCE_BACKED' AND "source_type" IS NOT NULL AND "source_id" IS NOT NULL
      AND "direct_retain_until" IS NULL)
    OR
    ("source_kind"='DIRECT' AND "source_type" IS NULL AND "source_id" IS NULL
      AND "source_revision" IS NULL AND "direct_retain_until" IS NOT NULL)
  )
);

CREATE TABLE "race_resolution_post_task_receipts" (
  "race_id" TEXT NOT NULL,
  "source_generation" INTEGER NOT NULL,
  "dedupe_key" TEXT NOT NULL,
  "terminal_state" VARCHAR(32) NOT NULL,
  "snapshot_state" VARCHAR(32) NOT NULL,
  "intent_count" INTEGER NOT NULL,
  "failure_count" INTEGER NOT NULL,
  "completed_at" TIMESTAMP(3) NOT NULL,
  CONSTRAINT "race_resolution_post_task_receipts_pkey" PRIMARY KEY ("race_id", "source_generation"),
  CONSTRAINT "race_resolution_post_task_receipts_dedupe_key_key" UNIQUE ("dedupe_key"),
  CONSTRAINT "race_resolution_post_task_receipts_race_fkey" FOREIGN KEY ("race_id")
    REFERENCES "races"("id") ON DELETE CASCADE ON UPDATE CASCADE,
  CONSTRAINT "race_resolution_post_task_receipts_counts_check" CHECK ("intent_count" >= 0 AND "failure_count" >= 0)
);

CREATE TABLE "race_resolution_delivery_intent_receipts" (
  "delivery_key_hash" CHAR(64) NOT NULL,
  "race_id" TEXT NOT NULL,
  "source_generation" INTEGER NOT NULL,
  "task_dedupe_key" TEXT NOT NULL,
  "intent_kind" VARCHAR(64) NOT NULL,
  "terminal_disposition" VARCHAR(32) NOT NULL,
  "completed_at" TIMESTAMP(3) NOT NULL,
  "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "race_resolution_delivery_intent_receipts_pkey" PRIMARY KEY ("delivery_key_hash"),
  CONSTRAINT "race_resolution_delivery_intent_receipts_race_fkey" FOREIGN KEY ("race_id")
    REFERENCES "races"("id") ON DELETE CASCADE ON UPDATE CASCADE
);

-- Previous binaries know only the outbox. Reserve a provisional receipt for
-- their inserts; the receipt-aware reconciler finalizes the audience-dependent
-- digest after the transaction is visible.
CREATE OR REPLACE FUNCTION reserve_legacy_domain_event_receipt()
RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP='UPDATE' AND OLD.status IS NOT DISTINCT FROM NEW.status THEN
    RETURN NEW;
  END IF;
  INSERT INTO domain_event_receipts (
    event_key, domain_event_id, event_type, schema_version, aggregate_type,
    aggregate_id, occurred_at, available_at, receipt_state, digest_version,
    replay_source_type, replay_source_id, created_at, updated_at
  ) VALUES (
    NEW.event_key, NEW.id, NEW.event_type, NEW.schema_version,
    NEW.aggregate_type, NEW.aggregate_id, NEW.occurred_at, NEW.available_at,
    'PROVISIONAL', 1, 'LEGACY_UNMAPPED', NEW.event_key, now(), now()
  ) ON CONFLICT (event_key) DO NOTHING;
  RETURN NEW;
END;
$$;

CREATE TRIGGER domain_event_outbox_legacy_receipt_trigger
AFTER INSERT ON domain_event_outbox
FOR EACH ROW EXECUTE FUNCTION reserve_legacy_domain_event_receipt();

-- Counters remain nullable until a bounded backfill stamps validity. The
-- trigger covers old binaries, raw batch writers, status transitions and
-- deletes during rolling overlap.
CREATE OR REPLACE FUNCTION maintain_domain_event_projection_counts()
RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE
  old_terminal integer := 0;
  new_terminal integer := 0;
  old_failed integer := 0;
  new_failed integer := 0;
  parent_id uuid;
BEGIN
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
     SET projection_count=projection_count +
           CASE WHEN TG_OP='INSERT' THEN 1 WHEN TG_OP='DELETE' THEN -1 ELSE 0 END,
         terminal_projection_count=terminal_projection_count + new_terminal - old_terminal,
         failed_projection_count=failed_projection_count + new_failed - old_failed
   WHERE id=parent_id
     AND projection_counts_valid_at IS NOT NULL
     AND (TG_OP IN ('INSERT','DELETE') OR new_terminal<>old_terminal OR new_failed<>old_failed);
  RETURN COALESCE(NEW, OLD);
END;
$$;

CREATE TRIGGER domain_event_projection_counter_trigger
AFTER INSERT OR UPDATE OF status OR DELETE ON domain_event_notification_projections
FOR EACH ROW EXECUTE FUNCTION maintain_domain_event_projection_counts();
