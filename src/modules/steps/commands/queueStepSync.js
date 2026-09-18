const crypto = require("node:crypto");
const {
  canonicalizeStepSyncRequest,
  validateIdempotencyKey,
} = require("../stepSyncCanonical");
const {
  publish,
  claimIdempotentWindow,
  STREAMS,
} = require("../../../shared/queues/redisStreams");
const { normalizeSamples } = require("./recordStepSamples");
const { STEP_SYNC_VERSION } = require("../../../shared/queues/workMessages");

async function queueStepSync({
  userId,
  body,
  idempotencyKey,
  timeZone = "UTC",
  homePull = false,
  legacyEventRecap = false,
  now = () => new Date(),
}) {
  validateIdempotencyKey(idempotencyKey);
  const { canonical, hash, json } = canonicalizeStepSyncRequest(body);
  // Preserve validation that previously happened during persistence. Queue-first
  // intake must reject a permanently invalid/manual sample before returning 202.
  normalizeSamples(canonical.samples);
  const syncId = crypto.randomUUID();
  const acceptedAt = now();
  if (homePull) {
    const admission = await claimIdempotentWindow(
      `queue:step-sync:home-pull:${userId}`,
      idempotencyKey,
      30_000,
    );
    if (!admission.acquired) {
      const error = new Error("Step sync is cooling down");
      error.name = "StepSyncCooldownError";
      error.code = "STEP_SYNC_COOLDOWN";
      error.retryAfterSeconds = Math.max(
        1,
        Math.min(30, Math.ceil(admission.retryAfterMs / 1000)),
      );
      throw error;
    }
  }
  await publish(STREAMS.STEP_SYNC, {
    schemaVersion: STEP_SYNC_VERSION,
    syncId,
    userId,
    idempotencyKey,
    timeZone,
    homePull: homePull ? "true" : "false",
    legacyEventRecap: legacyEventRecap ? "true" : "false",
    requestHash: hash,
    canonicalJson: json,
    requestedAt: acceptedAt.toISOString(),
  });
  return {
    state: "QUEUED",
    syncId,
    acceptedAt: acceptedAt.toISOString(),
    sampleCount: canonical.samples.length,
    uploaderReconciliation: {
      state: "DEFERRED",
      resolvedRaceCount: 0,
      boxStateCurrent: false,
    },
    raceResolution: {
      jobId: null,
      generation: null,
      state: "QUEUED",
      requestedAt: acceptedAt.toISOString(),
    },
    stepIntakeSemantics: "QUEUE_FIRST_V1",
  };
}

module.exports = { queueStepSync };
