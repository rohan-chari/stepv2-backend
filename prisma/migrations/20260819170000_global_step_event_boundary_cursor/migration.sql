-- Durable, cluster-owned cursor for global-event start/end boundary fan-out.
-- Epoch initialization does not lose historical crossings: the dispatcher
-- coalesces every due crossing through the latest one into one current FULL
-- enqueue per active race, then advances only after all enqueues succeed.
CREATE TABLE "global_step_event_boundary_cursors" (
  "key" TEXT NOT NULL,
  "boundary_at" TIMESTAMP(3) NOT NULL,
  "event_id" TEXT NOT NULL,
  "boundary_kind" VARCHAR(8) NOT NULL,
  "lease_expires_at" TIMESTAMP(3),
  "lease_token" TEXT,
  "updated_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "global_step_event_boundary_cursors_pkey" PRIMARY KEY ("key")
);

CREATE INDEX "global_step_event_boundary_cursors_lease_expires_at_idx"
  ON "global_step_event_boundary_cursors"("lease_expires_at");

INSERT INTO "global_step_event_boundary_cursors" (
  "key", "boundary_at", "event_id", "boundary_kind"
) VALUES ('global', TIMESTAMP '1970-01-01 00:00:00', '', '');
