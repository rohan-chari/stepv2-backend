const { prisma: defaultPrisma } = require("../db");

// Server-side idempotency reservation for one POST /steps/sync-v2 attempt group
// (§6.4 / §7). Keyed by (userId, idempotencyKey). Transaction A creates the row
// PROCESSING (with the validated timezone + request hash); Transaction B
// finalizes it to COMPLETE with the stored canonical response. A same-hash replay
// reads the stored response; a different-hash reuse of the key is a 409 conflict.
// Rows retain seven days.

const RETENTION_MS = 7 * 24 * 60 * 60 * 1000;

function buildStepSyncRequestModel(prisma = defaultPrisma) {
  return {
    RETENTION_MS,

    async findByKey(userId, idempotencyKey) {
      return prisma.stepSyncRequest.findUnique({
        where: { userId_idempotencyKey: { userId, idempotencyKey } },
      });
    },

    // Create the PROCESSING reservation. Runs inside the caller's transaction
    // (Transaction A) when `tx` is supplied so the steps/samples upsert and the
    // reservation commit atomically.
    async createReservation(
      { userId, idempotencyKey, requestHash, resolutionTimeZone, leaseMs = 0, now = new Date() },
      tx = prisma
    ) {
      return tx.stepSyncRequest.create({
        data: {
          userId,
          idempotencyKey,
          requestHash,
          resolutionTimeZone,
          state: "PROCESSING",
          leaseExpiresAt: leaseMs > 0 ? new Date(now.getTime() + leaseMs) : null,
          expiresAt: new Date(now.getTime() + RETENTION_MS),
        },
      });
    },

    // Claim the one-time step-event emission for this reservation. Conditional on
    // `eventsEmittedAt IS NULL` so a replay/recovery can never emit STEPS_*
    // events twice. Returns true only for the caller that won the claim.
    async claimEventsEmission(id, now = new Date()) {
      const claimed = await prisma.stepSyncRequest.updateMany({
        where: { id, eventsEmittedAt: null },
        data: { eventsEmittedAt: now },
      });
      return claimed.count === 1;
    },

    // Finalize the reservation to COMPLETE with the stored canonical response.
    async finalize({ id, responseJson, now = new Date() }, tx = prisma) {
      return tx.stepSyncRequest.update({
        where: { id },
        data: {
          state: "COMPLETE",
          responseJson,
          leaseExpiresAt: null,
          updatedAt: now,
        },
      });
    },

    // Best-effort cleanup of expired reservations (never affects correctness).
    async cleanupExpired(now = new Date()) {
      const result = await prisma.stepSyncRequest.deleteMany({
        where: { expiresAt: { lte: now } },
      });
      return result.count;
    },
  };
}

const StepSyncRequest = buildStepSyncRequestModel();

module.exports = { buildStepSyncRequestModel, StepSyncRequest, RETENTION_MS };
