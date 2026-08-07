const { prisma: defaultPrisma } = require("../../../db");
const { Race } = require("../models/race");
const { RaceParticipant } = require("../models/raceParticipant");
const { RaceActiveEffect } = require("../../powerups/models/raceActiveEffect");
const { RacePowerupEvent } = require("../../powerups/models/racePowerupEvent");
const {
  RaceResolutionJobV2: defaultJobModel,
  newLeaseToken,
  LEASE_MS,
} = require("../models/raceResolutionJobV2");
const {
  buildResolveRaceState,
} = require("../services/raceStateResolution");
const { createWriteCapture } = require("../services/computeRaceState");
const {
  syncRacePowerupState: defaultSyncRacePowerupState,
} = require("../services/racePowerupStateSync");
const {
  recentBoxMints: defaultRecentBoxMints,
} = require("../services/recentBoxMints");
const { nudgeOvertakenRivals } = require("../../steps/commands/recordSteps");
const { stepSyncPushService } = require("../../../shared/push/stepSyncPush");
const { appSettings: defaultAppSettings } = require("../../../shared/config/appSettings");
const {
  StepSyncRequest: defaultStepSyncRequestModel,
} = require("../../steps/models/stepSyncRequest");

const POLL_INTERVAL_MS = 250;
const QUEUE_LAG_LOG_INTERVAL_MS = 60 * 1000;
const QUEUE_LAG_ALARM_MS = 30 * 1000;
// Best-effort reservation cleanup cadence (never affects correctness). Carried
// over from the v1 scheduler, which src/index.js no longer starts.
const CLEANUP_INTERVAL_MS = 60 * 60 * 1000;

// §5a item 1 "worker handoff": the v2 worker must not claim while an OLD-binary
// worker could still be draining the per-user table during a `pm2 reload`
// overlap. 60s > the old worker's 30s lease + the reload window. Env-tunable so
// tests can shrink it (they assert the gate, not the wall-clock).
function quietPeriodMs() {
  const parsed = Number(process.env.RACE_QUEUE_V2_QUIET_PERIOD_MS);
  return Number.isFinite(parsed) && parsed >= 0 ? parsed : 60 * 1000;
}

// Thrown by the fenced write transaction when the job row no longer matches our
// lease token. It means the lease expired and someone else re-claimed the race,
// so we must roll back HAVING WRITTEN NOTHING and walk away without touching the
// job row (it belongs to the new owner now).
class FenceLostError extends Error {
  constructor() {
    super("Race resolution lease token no longer valid");
    this.name = "FenceLostError";
  }
}

// The write-capture proxy lives in services/computeRaceState.js — the SAME one
// the read-only callers (usePowerup's Trail Mine plant and Uprising gate) use.
// One capture, one definition of "the write surface of resolveRaceState": the
// worker replays the recorded writes inside its fence, the read-only callers
// discard them. A second copy here would be a second thing to keep in lockstep.

function buildRaceResolutionWorkerV2(dependencies = {}) {
  const prisma = dependencies.prisma || defaultPrisma;
  const raceModel = dependencies.Race || Race;
  const participantModel = dependencies.RaceParticipant || RaceParticipant;
  const effectModel = dependencies.RaceActiveEffect || RaceActiveEffect;
  const eventModel = dependencies.RacePowerupEvent || RacePowerupEvent;
  const jobModel = dependencies.RaceResolutionJobV2 || defaultJobModel;
  const syncRacePowerupState =
    dependencies.syncRacePowerupState || defaultSyncRacePowerupState;
  const recentBoxMints = dependencies.recentBoxMints || defaultRecentBoxMints;
  const requestStepSyncForUsers =
    dependencies.requestStepSyncForUsers ||
    stepSyncPushService.requestStepSyncForUsers;
  const nudge = dependencies.nudgeOvertakenRivals || nudgeOvertakenRivals;
  const settings = dependencies.appSettings || defaultAppSettings;
  const logger = dependencies.logger || console;
  const now = dependencies.now || (() => new Date());
  const leaseMs = dependencies.leaseMs ?? LEASE_MS;
  // Phase D hangs the Redis snapshot publish off this hook. It runs strictly
  // AFTER the Postgres commit — commit first, publish second (spec §5a item 5).
  // It also carries the two side effects Phase D step 8 takes off the
  // `/progress` request path and that nothing else covered: `expireEffects` and
  // the high-multiplier alert re-arm (see raceProgressSideEffects.js). The hook
  // is a no-op while `redisStandingsEnabled` is off, so the flag still gates
  // every behavior change on both sides of the split.
  const onCommitted =
    dependencies.onCommitted ||
    require("../services/raceProgressSideEffects").raceProgressPostCommit;

  const bootAt = dependencies.bootAt ?? Date.now();
  let oldQueueDrainedObserved = false;

  // (a) 60s quiet period after boot AND (b) one observation of the OLD table
  // with zero RUNNING-with-unexpired-lease rows. Once observed, the check is
  // never repeated: pm2 kills old workers within seconds of reload, so a single
  // clean observation proves the old bulk writer is gone. A missing old table
  // (post-contract restart) counts as drained.
  async function readyToClaim(currentTime) {
    if (Date.now() - bootAt < quietPeriodMs()) return false;
    if (oldQueueDrainedObserved) return true;
    try {
      const rows = await prisma.$queryRawUnsafe(
        `
        SELECT 1
        FROM race_resolution_jobs
        WHERE state = 'running'
          AND lease_expires_at IS NOT NULL
          AND lease_expires_at > $1
        LIMIT 1
        `,
        currentTime
      );
      if (rows.length === 0) {
        oldQueueDrainedObserved = true;
        return true;
      }
      return false;
    } catch (error) {
      // 42P01 undefined_table => the old table is gone; nothing to hand off from.
      if (error && (error.code === "42P01" || String(error.message || "").includes("does not exist"))) {
        oldQueueDrainedObserved = true;
        return true;
      }
      logger.error("[RACE_RESOLUTION_V2] old-queue drain check failed:", error);
      return false;
    }
  }

  async function claimingDisabled() {
    return (await settings.getUncachedFlag("raceQueueV2ClaimingDisabled")) === true;
  }

  // ── The fenced ownership protocol (§5a item 5). Ordering is NOT negotiable. ──
  //
  //   1. claim (elsewhere) mints a fresh lease token
  //   2. run the computation OUTSIDE any transaction, capturing its writes
  //   3. ONE write transaction:
  //        (i)   SELECT ... FOR UPDATE the job row WHERE id AND lease_token.
  //              Zero rows => abort immediately, having written NOTHING.
  //        (ii)  only as the verified lock-holder, write all participant rows,
  //              in ASCENDING userId order (the one global lock order)
  //        (iii) update the job row
  //        commit
  //
  // Fence-THEN-write, never write-then-fence: two workers can never both be
  // mid-flight on participant rows because the loser is turned away at the
  // job-row lock before its first participant write. The held job-row lock also
  // serializes this against raceExpiry, which acquires the same row.
  async function processOne() {
    const currentTime = now();
    if (await claimingDisabled()) return null;
    if (!(await readyToClaim(currentTime))) return null;

    const job = await jobModel.claimNext({
      now: currentTime,
      leaseMs,
      leaseToken: newLeaseToken(),
    });
    if (!job) return null;

    const startMs = Date.now();
    const triggeringUserIds = Array.isArray(job.processingTriggeredByUserIds)
      ? job.processingTriggeredByUserIds.filter(Boolean)
      : [];

    try {
      // ── Step 2: computation, outside every transaction. ──────────────────
      const capture = createWriteCapture({ participantModel, effectModel, eventModel });
      const computeResolve = buildResolveRaceState({
        Race: raceModel,
        RaceParticipant: capture.participants,
        RaceActiveEffect: capture.effects,
        RacePowerupEvent: capture.events,
        now,
      });
      const processed = await computeResolve({
        raceId: job.raceId,
        userIds: triggeringUserIds,
        timeZone: job.processingTimeZone || "UTC",
      });
      const result = Array.isArray(processed) ? processed[0] : null;

      // Participant id -> userId, so the write replay can sort by userId. The
      // race object the computation already loaded carries every participant;
      // an unmapped id sorts last but deterministically (by participant id).
      const userIdByParticipant = new Map();
      for (const p of result?.race?.participants || []) {
        userIdByParticipant.set(p.id, p.userId);
      }
      const sortKey = (w) =>
        `${userIdByParticipant.get(w.participantId) ?? "￿"}:${w.participantId}`;

      const participantWrites = capture.writes
        .filter((w) => w.kind === "participantTotal" || w.kind === "participantBonus")
        .sort((a, b) => sortKey(a).localeCompare(sortKey(b)));
      const sideWrites = capture.writes.filter(
        (w) => w.kind === "effectUpdate" || w.kind === "eventCreate"
      );

      // ── Step 3: the ONE write transaction. ───────────────────────────────
      let superseded = false;
      await prisma.$transaction(async (tx) => {
        // (i) fence
        const fenced = await jobModel.acquireForWrite(tx, {
          id: job.id,
          expectedLeaseToken: job.leaseToken,
        });
        if (!fenced) throw new FenceLostError();

        // (ii) participant rows, ascending userId
        for (const write of participantWrites) {
          if (write.kind === "participantTotal") {
            await tx.raceParticipant.update({
              where: { id: write.participantId },
              data: { totalSteps: write.totalSteps, totalsUpdatedAt: now() },
            });
          } else {
            await tx.raceParticipant.update({
              where: { id: write.participantId },
              data: { bonusSteps: { decrement: write.amount } },
            });
          }
        }

        // Trail-mine bookkeeping (effect status + feed row) rides the same
        // transaction, so a detonation is all-or-nothing with the totals it
        // adjusted. Fire-once serialization comes free from the fence.
        for (const write of sideWrites) {
          if (write.kind === "effectUpdate") {
            await tx.raceActiveEffect.update({
              where: { id: write.id },
              data: write.fields,
            });
          } else {
            await tx.racePowerupEvent.create({ data: write.data });
          }
        }

        // (iii) job row
        const outcome = await jobModel.recordSuccess(
          {
            id: job.id,
            leaseToken: job.leaseToken,
            processingGeneration: job.processingGeneration,
            now: now(),
          },
          tx
        );
        if (!outcome.applied) throw new FenceLostError();
        superseded = outcome.superseded;
      },
      // Only short writes run inside the fence (the expensive replay already
      // happened outside it), but a large field is still N row updates — give it
      // headroom past Prisma's 5s default so a big race can never be aborted
      // mid-write by a transaction timeout.
      { timeout: 15_000, maxWait: 10_000 });

      // ── Post-commit. Everything below is best-effort and holds no lock. ──
      try {
        await onCommitted({ raceId: job.raceId, job, result });
      } catch (error) {
        logger.error("[RACE_RESOLUTION_V2] post-commit hook error:", error);
      }

      // Box state / powerup-slot sync for EVERY user in the processing snapshot
      // (§5a item 2) — coalescing must not lose a triggering user's box roll.
      if (result) {
        const boxByUser = result.boxEffectiveStepsByUser || {};
        for (const triggerUserId of [...triggeringUserIds].sort()) {
          try {
            const syncResult = await syncRacePowerupState({
              raceId: result.raceId,
              userId: triggerUserId,
              race: result.race,
              boxEffectiveSteps: boxByUser[triggerUserId] ?? null,
            });
            // C3 / spec v9 item 2: this is the ONLY place an in-race box is
            // minted once Phase D is on, so it is the only place that can tell
            // the viewer's next `/progress` poll a box appeared. Record it for
            // the toast; the overlay consumes it. Best-effort and flag-gated —
            // a Redis hiccup costs a celebration, never a box.
            await recentBoxMints.record({
              userId: triggerUserId,
              raceId: result.raceId,
              syncResult,
            });
          } catch (error) {
            logger.error(
              `[RACE_RESOLUTION_V2] powerup state sync failed (${triggerUserId}):`,
              error
            );
          }
        }

        for (const triggerUserId of triggeringUserIds) {
          try {
            await nudge({
              raceResults: [result],
              userId: triggerUserId,
              participantModel,
              requestStepSyncForUsers,
            });
          } catch (error) {
            logger.error("[RACE_RESOLUTION_V2] overtake nudge error:", error);
          }
        }
      }

      logger.log(
        `[RACE_RESOLUTION_V2] race=${job.raceId} gen=${job.processingGeneration} ` +
          `users=${triggeringUserIds.length} resolved=${result ? 1 : 0} ` +
          `superseded=${superseded} ms=${Date.now() - startMs}`
      );
      return job;
    } catch (error) {
      if (error instanceof FenceLostError) {
        // Lost the lease mid-run. Nothing was written and the job row belongs to
        // whoever re-claimed it — recording a failure here would stomp them.
        logger.log(
          `[RACE_RESOLUTION_V2] race=${job.raceId} fence lost (lease reassigned); aborted with no writes`
        );
        return job;
      }
      logger.error(`[RACE_RESOLUTION_V2] race=${job.raceId} failed:`, error);
      try {
        await jobModel.recordFailure({
          id: job.id,
          leaseToken: job.leaseToken,
          attempts: job.attempts,
          errorCode: error && error.code ? String(error.code) : "WORKER_ERROR",
          now: now(),
        });
      } catch (failureError) {
        logger.error("[RACE_RESOLUTION_V2] recordFailure failed:", failureError);
      }
      return job;
    }
  }

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

  async function logQueueLag() {
    try {
      const lagMs = await jobModel.queueLagMs(now());
      const level = lagMs > QUEUE_LAG_ALARM_MS ? "warn" : "log";
      (logger[level] || logger.log).call(
        logger,
        `[RACE_RESOLUTION_V2] queue_lag_ms=${lagMs}` +
          (lagMs > QUEUE_LAG_ALARM_MS ? " ALARM(>30s) — raise ASYNC_RACE_RESOLUTION_CONCURRENCY" : "")
      );
      return lagMs;
    } catch (error) {
      logger.error("[RACE_RESOLUTION_V2] queue lag probe failed:", error);
      return null;
    }
  }

  return { processOne, tick, logQueueLag, readyToClaim, claimingDisabled, FenceLostError };
}

function scheduleRaceResolutionWorkerV2(dependencies = {}) {
  const logger = dependencies.logger || console;
  const worker = buildRaceResolutionWorkerV2(dependencies);

  let running = false;
  const interval = setInterval(async () => {
    if (running) return;
    running = true;
    try {
      await worker.tick();
    } catch (error) {
      logger.error("[RACE_RESOLUTION_V2] tick error:", error);
    } finally {
      running = false;
    }
  }, POLL_INTERVAL_MS);
  if (interval.unref) interval.unref();

  // Backpressure metric, once a minute (Phase A0 step (c) — shipped so before/
  // after lag is comparable across the C0 cutover).
  const lagInterval = setInterval(() => {
    worker.logQueueLag().catch(() => {});
  }, QUEUE_LAG_LOG_INTERVAL_MS);
  if (lagInterval.unref) lagInterval.unref();

  const stepSyncRequestModel =
    dependencies.StepSyncRequest || defaultStepSyncRequestModel;
  const cleanup = setInterval(() => {
    stepSyncRequestModel.cleanupExpired(new Date()).catch(() => {});
  }, CLEANUP_INTERVAL_MS);
  if (cleanup.unref) cleanup.unref();

  logger.log(
    "[CRON] Race-keyed (v2) resolution worker scheduled (poll 250ms, " +
      `${quietPeriodMs() / 1000}s startup quiet period)`
  );
  return { interval, lagInterval, cleanup, worker };
}

module.exports = {
  buildRaceResolutionWorkerV2,
  scheduleRaceResolutionWorkerV2,
  FenceLostError,
  createWriteCapture,
  quietPeriodMs,
  POLL_INTERVAL_MS,
};
