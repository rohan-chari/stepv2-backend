const { prisma: defaultPrisma } = require("../../../db");

// Durable, per-user race-resolution queue (§7). One row per user (unique
// userId). Enqueue upserts + bumps `generation`; the worker claims with
// FOR UPDATE SKIP LOCKED, snapshots the generation + timezone, and only records
// success when the claimed generation still matches (else a newer sync
// superseded it and the row returns to QUEUED).

const LEASE_MS = 30 * 1000; // 30-second processing lease
// Retry transient failures at 1s, 5s, 30s; after 3 attempts mark FAILED.
const RETRY_BACKOFF_MS = [1000, 5000, 30000];
const MAX_ATTEMPTS = 3;

function buildRaceResolutionJobModel(prisma = defaultPrisma) {
  return {
    LEASE_MS,
    MAX_ATTEMPTS,

    // Enqueue is an upsert by userId: increment generation, set QUEUED, reset
    // attempts/retry, and preserve the stable row id. Runs inside the caller's
    // transaction when `tx` is provided (Transaction B of sync-v2) so the queue
    // row is only visible to the worker after the idempotency row is COMPLETE.
    async enqueue({ userId, resolutionTimeZone, now = new Date() }, tx = prisma) {
      return tx.raceResolutionJob.upsert({
        where: { userId },
        create: {
          userId,
          generation: 1,
          resolutionTimeZone,
          state: "QUEUED",
          attempts: 0,
          requestedAt: now,
          retryAt: null,
        },
        update: {
          generation: { increment: 1 },
          resolutionTimeZone,
          state: "QUEUED",
          attempts: 0,
          requestedAt: now,
          retryAt: null,
          startedAt: null,
          completedAt: null,
          leaseExpiresAt: null,
          lastErrorCode: null,
        },
      });
    },

    // Atomically claim ONE eligible job with FOR UPDATE SKIP LOCKED so multiple
    // workers/processes never grab the same row. Eligible = QUEUED and due, OR a
    // RUNNING row whose lease has expired (crash recovery). Sets RUNNING,
    // snapshots generation -> processingGeneration and resolutionTimeZone ->
    // processingTimeZone, takes a fresh lease, and increments attempts.
    async claimNext({ now = new Date(), leaseMs = LEASE_MS } = {}) {
      return prisma.$transaction(async (tx) => {
        const rows = await tx.$queryRaw`
          SELECT id, generation, resolution_time_zone AS "resolutionTimeZone"
          FROM race_resolution_jobs
          WHERE (state = 'queued' AND (retry_at IS NULL OR retry_at <= ${now}))
             OR (state = 'running' AND lease_expires_at IS NOT NULL AND lease_expires_at <= ${now})
          ORDER BY requested_at ASC
          LIMIT 1
          FOR UPDATE SKIP LOCKED
        `;
        if (!rows || rows.length === 0) return null;
        const row = rows[0];
        return tx.raceResolutionJob.update({
          where: { id: row.id },
          data: {
            state: "RUNNING",
            processingGeneration: row.generation,
            processingTimeZone: row.resolutionTimeZone,
            startedAt: now,
            leaseExpiresAt: new Date(now.getTime() + leaseMs),
            attempts: { increment: 1 },
          },
        });
      });
    },

    // Record success ONLY if the row's current generation still equals the
    // generation this worker processed; otherwise a newer enqueue arrived while
    // we ran, so return the row to QUEUED for reprocessing. Returns { superseded }.
    async recordSuccess({ id, processingGeneration, now = new Date() }) {
      const succeeded = await prisma.raceResolutionJob.updateMany({
        where: { id, generation: processingGeneration },
        data: {
          state: "SUCCEEDED",
          completedAt: now,
          retryAt: null,
          leaseExpiresAt: null,
          lastErrorCode: null,
        },
      });
      if (succeeded.count === 1) return { superseded: false };
      // Generation advanced under us: requeue the newest generation.
      await prisma.raceResolutionJob.updateMany({
        where: { id, state: "RUNNING" },
        data: { state: "QUEUED", leaseExpiresAt: null, retryAt: null },
      });
      return { superseded: true };
    },

    // Record a transient failure: retry with backoff while attempts remain,
    // otherwise mark FAILED. A later enqueue resets attempts and requeues.
    async recordFailure({ id, attempts, errorCode = null, now = new Date() }) {
      if (attempts < MAX_ATTEMPTS) {
        const backoff = RETRY_BACKOFF_MS[Math.min(attempts - 1, RETRY_BACKOFF_MS.length - 1)];
        await prisma.raceResolutionJob.update({
          where: { id },
          data: {
            state: "QUEUED",
            retryAt: new Date(now.getTime() + backoff),
            leaseExpiresAt: null,
            lastErrorCode: errorCode,
          },
        });
        return { state: "QUEUED" };
      }
      await prisma.raceResolutionJob.update({
        where: { id },
        data: {
          state: "FAILED",
          completedAt: now,
          retryAt: null,
          leaseExpiresAt: null,
          lastErrorCode: errorCode,
        },
      });
      return { state: "FAILED" };
    },

    async findById(id) {
      return prisma.raceResolutionJob.findUnique({ where: { id } });
    },

    async findByUserId(userId) {
      return prisma.raceResolutionJob.findUnique({ where: { userId } });
    },
  };
}

// Serialize a job for the owner-only status endpoint (§6.5). If the stored row
// has advanced beyond the requested generation, present it as SUPERSEDED with
// the requested generation and null timestamps so the client stops polling. Error
// detail is never surfaced.
function serializeRaceResolutionStatus(job, requestedGeneration) {
  if (!job) return null;
  if (job.generation > requestedGeneration) {
    return {
      jobId: job.id,
      generation: requestedGeneration,
      state: "SUPERSEDED",
      requestedAt: job.requestedAt,
      startedAt: null,
      completedAt: null,
      retryAt: null,
    };
  }
  return {
    jobId: job.id,
    generation: job.generation,
    state: job.state, // QUEUED | RUNNING | SUCCEEDED | FAILED
    requestedAt: job.requestedAt,
    startedAt: job.startedAt ?? null,
    completedAt: job.completedAt ?? null,
    retryAt: job.retryAt ?? null,
  };
}

const RaceResolutionJob = buildRaceResolutionJobModel();

module.exports = {
  buildRaceResolutionJobModel,
  RaceResolutionJob,
  serializeRaceResolutionStatus,
  LEASE_MS,
  MAX_ATTEMPTS,
  RETRY_BACKOFF_MS,
};
