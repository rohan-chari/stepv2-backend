const { Race } = require("../models/race");
const { RaceParticipant } = require("../models/raceParticipant");
const {
  RaceResolutionJob: defaultRaceResolutionJobModel,
} = require("../models/raceResolutionJob");
const {
  StepSyncRequest: defaultStepSyncRequestModel,
} = require("../models/stepSyncRequest");
const {
  resolveRaceState: defaultResolveRaceState,
} = require("../services/raceStateResolution");
const {
  syncRacePowerupState: defaultSyncRacePowerupState,
} = require("../services/racePowerupStateSync");
const {
  withRaceResolutionLock: defaultWithRaceResolutionLock,
} = require("../services/withRaceResolutionLock");
const { nudgeOvertakenRivals } = require("../commands/recordSteps");
const { stepSyncPushService } = require("../services/stepSyncPush");

const POLL_INTERVAL_MS = 250;
// Best-effort reservation cleanup cadence (never affects correctness).
const CLEANUP_INTERVAL_MS = 60 * 60 * 1000;

// Durable, restart-safe worker for the per-user race-resolution queue (Phase D4).
// It claims one job at a time with FOR UPDATE SKIP LOCKED, then runs the FULL-
// FIELD reconciliation for the user's active races with the job's snapshotted
// `processingTimeZone` — never the server locale/UTC. Each race is reconciled
// under the shared per-race advisory lock, in stable sorted order, so it never
// interleaves with the uploader/legacy/placement paths. After resolving it runs
// the existing uploader powerup sync and overtake nudge in the same order as the
// synchronous recordSteps path. Success only counts if the job's generation was
// not superseded mid-run; transient failures retry with backoff.
function buildRaceResolutionWorker(dependencies = {}) {
  const raceModel = dependencies.Race || Race;
  const participantModel = dependencies.RaceParticipant || RaceParticipant;
  const jobModel = dependencies.RaceResolutionJob || defaultRaceResolutionJobModel;
  const stepSyncRequestModel =
    dependencies.StepSyncRequest || defaultStepSyncRequestModel;
  const resolveRaceState = dependencies.resolveRaceState || defaultResolveRaceState;
  const syncRacePowerupState =
    dependencies.syncRacePowerupState || defaultSyncRacePowerupState;
  const withRaceResolutionLock =
    dependencies.withRaceResolutionLock || defaultWithRaceResolutionLock;
  const requestStepSyncForUsers =
    dependencies.requestStepSyncForUsers ||
    stepSyncPushService.requestStepSyncForUsers;
  const nudge = dependencies.nudgeOvertakenRivals || nudgeOvertakenRivals;
  const logger = dependencies.logger || console;
  const now = dependencies.now || (() => new Date());

  // Full-field reconciliation for one claimed job. Resolves each of the user's
  // active races under its advisory lock (sorted order), then syncs the
  // uploader's powerup state and nudges overtaken rivals.
  async function reconcileFull({ userId, timeZone }) {
    const races = await raceModel.findActiveForUser(userId);
    const orderedIds = races
      .map((r) => r.id)
      .sort((a, b) => String(a).localeCompare(String(b)));

    const raceResults = [];
    for (const raceId of orderedIds) {
      await withRaceResolutionLock(raceId, async () => {
        const processed = await resolveRaceState({ raceId, userId, timeZone });
        const result = Array.isArray(processed) ? processed[0] : null;
        if (result) {
          await syncRacePowerupState({
            raceId: result.raceId,
            userId,
            race: result.race,
            boxEffectiveSteps: result.boxEffectiveSteps,
          });
          raceResults.push(result);
        }
      });
    }

    // Same overtake nudge the synchronous recordSteps path fires (best-effort).
    try {
      await nudge({
        raceResults,
        userId,
        participantModel,
        requestStepSyncForUsers,
      });
    } catch (error) {
      logger.error("Race resolution worker overtake nudge error:", error);
    }

    return raceResults.length;
  }

  // Claim + process exactly one eligible job. Returns the claimed job (or null
  // when the queue is empty). Records success/failure and metrics.
  async function processOne() {
    const job = await jobModel.claimNext({ now: now() });
    if (!job) return null;

    const startMs = Date.now();
    try {
      const resolvedRaceCount = await reconcileFull({
        userId: job.userId,
        timeZone: job.processingTimeZone,
      });
      const { superseded } = await jobModel.recordSuccess({
        id: job.id,
        processingGeneration: job.processingGeneration,
        now: now(),
      });
      logger.log(
        `[RACE_RESOLUTION] job=${job.id} gen=${job.processingGeneration} ` +
          `races=${resolvedRaceCount} superseded=${superseded} ms=${Date.now() - startMs}`
      );
      return job;
    } catch (error) {
      logger.error(`[RACE_RESOLUTION] job=${job.id} failed:`, error);
      await jobModel.recordFailure({
        id: job.id,
        attempts: job.attempts,
        errorCode: error && error.code ? String(error.code) : "WORKER_ERROR",
        now: now(),
      });
      return job;
    }
  }

  // Drain up to `max` eligible jobs in one tick (default 1 concurrent job per
  // process to protect the DB pool; bounded override after staging verification).
  async function tick() {
    if (process.env.ASYNC_RACE_RESOLUTION_WORKER_DISABLED === "true") return 0;
    const concurrency = Math.min(
      2,
      Math.max(1, Number(process.env.ASYNC_RACE_RESOLUTION_CONCURRENCY) || 1)
    );
    let processed = 0;
    for (let i = 0; i < concurrency; i++) {
      const job = await processOne();
      if (!job) break;
      processed += 1;
    }
    return processed;
  }

  return { processOne, tick, reconcileFull };
}

// Register the polling worker. Called after the cron startup delay from index.js.
function scheduleRaceResolutionWorker(dependencies = {}) {
  const logger = dependencies.logger || console;
  const worker = buildRaceResolutionWorker(dependencies);
  const stepSyncRequestModel =
    dependencies.StepSyncRequest || defaultStepSyncRequestModel;

  let running = false;
  const interval = setInterval(async () => {
    if (running) return; // in-process overlap guard
    running = true;
    try {
      await worker.tick();
    } catch (error) {
      logger.error("[RACE_RESOLUTION] tick error:", error);
    } finally {
      running = false;
    }
  }, POLL_INTERVAL_MS);
  if (interval.unref) interval.unref();

  // Best-effort cleanup of expired idempotency reservations.
  const cleanup = setInterval(() => {
    stepSyncRequestModel.cleanupExpired(new Date()).catch(() => {});
  }, CLEANUP_INTERVAL_MS);
  if (cleanup.unref) cleanup.unref();

  logger.log("[CRON] Race resolution queue worker scheduled (poll every 250ms)");
  return { interval, cleanup };
}

module.exports = { buildRaceResolutionWorker, scheduleRaceResolutionWorker };
