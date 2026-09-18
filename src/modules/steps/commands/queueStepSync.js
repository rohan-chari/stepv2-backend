const crypto = require("node:crypto");
const {
  canonicalizeStepSyncRequest,
  validateIdempotencyKey,
} = require("../stepSyncCanonical");
const { publish, STREAMS } = require("../../../shared/queues/redisStreams");
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
    stepIntakeSemantics: "QUEUE_FIRST_V1",
  };
}

module.exports = { queueStepSync };
