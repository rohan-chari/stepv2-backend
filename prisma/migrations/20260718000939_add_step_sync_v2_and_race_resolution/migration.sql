-- Async step sync (Home/Races Refresh Performance). ADDITIVE ONLY.
--
-- Two new tables backing POST /steps/sync-v2 and the durable per-user race-
-- resolution worker:
--   * step_sync_requests   — server-side idempotency reservation + stored
--     canonical response for one sync-v2 attempt group, keyed by
--     (user_id, idempotency_key). Persists the validated request timezone so
--     recovery/finalization never re-derives it.
--   * race_resolution_jobs — one durable full-field resolution job per user
--     (unique user_id). Enqueue upserts + bumps `generation`; the worker claims
--     with FOR UPDATE SKIP LOCKED and snapshots the generation + timezone.
--
-- Back-compat: no existing column/table/constraint is dropped, renamed, or made
-- required. Old backend code ignores these tables; old app builds never call the
-- v2 endpoint (they keep POST /steps + POST /steps/samples). A mixed-version
-- deploy (old code, new tables) is safe.

-- CreateEnum
CREATE TYPE "StepSyncRequestState" AS ENUM ('processing', 'complete');

-- CreateEnum
CREATE TYPE "RaceResolutionJobState" AS ENUM ('queued', 'running', 'succeeded', 'failed');

-- CreateTable
CREATE TABLE "step_sync_requests" (
    "id" TEXT NOT NULL,
    "user_id" TEXT NOT NULL,
    "idempotency_key" VARCHAR(36) NOT NULL,
    "request_hash" CHAR(64) NOT NULL,
    "resolution_time_zone" VARCHAR(255) NOT NULL,
    "state" "StepSyncRequestState" NOT NULL DEFAULT 'processing',
    "response_json" JSONB,
    "lease_expires_at" TIMESTAMP(3),
    "events_emitted_at" TIMESTAMP(3),
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,
    "expires_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "step_sync_requests_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "race_resolution_jobs" (
    "id" TEXT NOT NULL,
    "user_id" TEXT NOT NULL,
    "generation" INTEGER NOT NULL DEFAULT 1,
    "processing_generation" INTEGER,
    "resolution_time_zone" VARCHAR(255) NOT NULL,
    "processing_time_zone" VARCHAR(255),
    "state" "RaceResolutionJobState" NOT NULL DEFAULT 'queued',
    "attempts" INTEGER NOT NULL DEFAULT 0,
    "requested_at" TIMESTAMP(3) NOT NULL,
    "started_at" TIMESTAMP(3),
    "completed_at" TIMESTAMP(3),
    "retry_at" TIMESTAMP(3),
    "lease_expires_at" TIMESTAMP(3),
    "last_error_code" TEXT,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "race_resolution_jobs_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "step_sync_requests_expires_at_idx" ON "step_sync_requests"("expires_at");

-- CreateIndex
CREATE UNIQUE INDEX "step_sync_requests_user_id_idempotency_key_key" ON "step_sync_requests"("user_id", "idempotency_key");

-- CreateIndex
CREATE UNIQUE INDEX "race_resolution_jobs_user_id_key" ON "race_resolution_jobs"("user_id");

-- CreateIndex
CREATE INDEX "race_resolution_jobs_state_retry_at_idx" ON "race_resolution_jobs"("state", "retry_at");

-- CreateIndex
CREATE INDEX "race_resolution_jobs_lease_expires_at_idx" ON "race_resolution_jobs"("lease_expires_at");

-- AddForeignKey
ALTER TABLE "step_sync_requests" ADD CONSTRAINT "step_sync_requests_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "race_resolution_jobs" ADD CONSTRAINT "race_resolution_jobs_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;
