-- Durable, version-stamped pacing for GLOBAL_EVENT_STARTED provider attempts.
-- All columns are nullable so the previous binary can continue inserting its
-- legacy notification rows during a rolling schema deployment. New states are
-- deliberately outside the old PENDING/RETRY/LEASED claim predicates.
CREATE EXTENSION IF NOT EXISTS pgcrypto;

ALTER TABLE "notification_schedules"
  ADD COLUMN "admission_class" VARCHAR(64),
  ADD COLUMN "admission_sequence" BIGINT;

ALTER TABLE "inbox_delivery_outbox"
  ADD COLUMN "admission_class" VARCHAR(64),
  ADD COLUMN "admission_sequence" BIGINT,
  ADD COLUMN "admission_expires_at" TIMESTAMPTZ(3);

CREATE TABLE "notification_release_lanes" (
  "admission_class" VARCHAR(64) NOT NULL,
  "next_token_at" TIMESTAMPTZ(3) NOT NULL,
  "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updated_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "notification_release_lanes_pkey" PRIMARY KEY ("admission_class")
);

CREATE INDEX "notification_schedules_admission_class_status_available_at_admission_sequence_id_idx"
  ON "notification_schedules"("admission_class", "status", "available_at", "admission_sequence", "id");
CREATE INDEX "inbox_delivery_outbox_admission_class_status_available_at_admission_sequence_id_idx"
  ON "inbox_delivery_outbox"("admission_class", "status", "available_at", "admission_sequence", "id");

INSERT INTO "notification_release_lanes" ("admission_class", "next_token_at")
VALUES ('visible:GLOBAL_EVENT_STARTED', transaction_timestamp())
ON CONFLICT ("admission_class") DO NOTHING;

-- Stamp source-backed schedules that an old release has not materialized.
UPDATE "notification_schedules" schedule
   SET "admission_class"='visible:GLOBAL_EVENT_STARTED',
       "admission_sequence"=(('x' || substr(encode(digest(schedule."delivery_key", 'sha256'), 'hex'), 1, 16))::bit(64)::bigint & 9223372036854775807),
       "status"='ADMISSION_PENDING',
       "expires_at"=LEAST(schedule."expires_at", entitlement."ends_at" - interval '60 seconds'),
       "updated_at"=transaction_timestamp()
  FROM "global_step_event_entitlements" entitlement
 WHERE schedule."type"='GLOBAL_EVENT_STARTED'
   AND schedule."source_ref"=entitlement."id"
   AND schedule."status"='PENDING';

-- Stamp unleased legacy first attempts and retries. Active old LEASED rows are
-- intentionally left for the startup barrier after their lease expires.
UPDATE "inbox_delivery_outbox" outbox
   SET "admission_class"='visible:GLOBAL_EVENT_STARTED',
       "admission_sequence"=(('x' || substr(encode(digest(alert."source_key", 'sha256'), 'hex'), 1, 16))::bit(64)::bigint & 9223372036854775807),
       "admission_expires_at"=COALESCE(schedule."expires_at", outbox."expires_at" - interval '60 seconds'),
       "expires_at"=COALESCE(schedule."expires_at", outbox."expires_at" - interval '60 seconds'),
       "status"=CASE outbox."status" WHEN 'PENDING' THEN 'ADMISSION_FIRST' ELSE 'ADMISSION_RETRY' END,
       "updated_at"=transaction_timestamp()
  FROM "inbox_alerts" alert
  LEFT JOIN "notification_schedules" schedule
    ON schedule."recipient_user_id"=alert."user_id" AND schedule."delivery_key"=alert."source_key"
 WHERE outbox."alert_id"=alert."id"
   AND alert."type"='GLOBAL_EVENT_STARTED'
   AND COALESCE(outbox."expires_at",schedule."expires_at") IS NOT NULL
   AND outbox."status" IN ('PENDING','RETRY');

UPDATE "inbox_delivery_outbox" outbox
   SET "admission_class"='visible:GLOBAL_EVENT_STARTED',
       "admission_sequence"=(('x' || substr(encode(digest(alert."source_key", 'sha256'), 'hex'), 1, 16))::bit(64)::bigint & 9223372036854775807),
       "admission_expires_at"=COALESCE(schedule."expires_at", outbox."expires_at" - interval '60 seconds'),
       "expires_at"=COALESCE(schedule."expires_at", outbox."expires_at" - interval '60 seconds'),
       "status"='ADMISSION_RETRY', "lease_until"=NULL, "lease_token"=NULL,
       "updated_at"=transaction_timestamp()
  FROM "inbox_alerts" alert
  LEFT JOIN "notification_schedules" schedule
    ON schedule."recipient_user_id"=alert."user_id" AND schedule."delivery_key"=alert."source_key"
 WHERE outbox."alert_id"=alert."id"
   AND alert."type"='GLOBAL_EVENT_STARTED'
   AND COALESCE(outbox."expires_at",schedule."expires_at") IS NOT NULL
   AND outbox."status"='LEASED'
   AND outbox."lease_until" <= transaction_timestamp();
