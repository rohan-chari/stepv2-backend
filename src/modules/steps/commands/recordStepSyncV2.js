const { prisma: defaultPrisma } = require("../../../db");
const { StepSyncRequest: defaultStepSyncRequestModel } = require("../models/stepSyncRequest");
const { stepInputIntake: defaultStepInputIntake } = require("../services/stepInputIntake");
const { eventBus: defaultEventBus } = require("../../../shared/events/eventBus");
const {
  canonicalizeStepSyncRequest,
  validateIdempotencyKey,
  StepSyncValidationError,
} = require("../stepSyncCanonical");
const { normalizeSamples, removeOverlaps } = require("./recordStepSamples");
const { appSettings: defaultAppSettings } = require("../../../shared/config/appSettings");
const { isStrictFlagEnabled } = require("../../../shared/config/isStrictFlagEnabled");
const {
  recordStepTelemetryPhase,
  measureStepTelemetryPhase,
  markStepTelemetryTransactionError,
  releaseStepAdmission,
} = require("../../../shared/observability/stepTelemetryContext");
const {
  lastStepSyncWriteBatch,
} = require("../services/lastStepSyncWriteBatch");
const redisCache = require("../../../shared/cache/redisCache");
const {
  coordinatedOptimizationMetrics,
} = require("../../../shared/observability/coordinatedOptimizationMetrics");

const COMPAT_STEP_GOAL = 5000;
const RECONCILE_LEASE_MS = 30 * 1000;
const DEFAULT_MAX_WAIT_MS = 5000;
const DEFAULT_POLL_MS = 150;
const HOME_PULL_COOLDOWN_SECONDS = 30;
const STEP_INTAKE_SEMANTICS = "CANONICAL_SOURCE_QUEUE_V1";
const CAPTURE_CLOSURE_RETRIES = 3;

function isSummaryCaptureClosureChanged(error) {
  return error?.code === "SUMMARY_CAPTURE_CLOSURE_CHANGED";
}

class StepSyncCooldownError extends Error {
  constructor(retryAfterSeconds) {
    super("Step sync is cooling down");
    this.name = "StepSyncCooldownError";
    this.code = "STEP_SYNC_COOLDOWN";
    this.statusCode = 429;
    this.retryAfterSeconds = Math.max(
      1,
      Math.min(HOME_PULL_COOLDOWN_SECONDS, Math.ceil(retryAfterSeconds || 1))
    );
  }
}

class StepSyncConflictError extends Error {
  constructor() {
    super("Idempotency key already used");
    this.name = "StepSyncConflictError";
    this.code = "IDEMPOTENCY_CONFLICT";
    this.statusCode = 409;
  }
}

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

function serializeRecord(step) {
  return {
    id: step.id,
    userId: step.userId,
    date: step.date,
    steps: step.steps,
    stepGoal: step.stepGoal ?? COMPAT_STEP_GOAL,
  };
}

function buildResponse({ record, sampleCount, jobs, requestedAt, globalEventSummaryWork = null }) {
  const reported = (jobs || []).find(Boolean) || null;
  return {
    record: serializeRecord(record),
    sampleCount,
    uploaderReconciliation: {
      state: "DEFERRED",
      resolvedRaceCount: 0,
      boxStateCurrent: false,
    },
    raceResolution: {
      jobId: reported ? reported.id : null,
      generation: reported ? reported.generation : null,
      state: "QUEUED",
      requestedAt: reported ? reported.requestedAt : requestedAt,
    },
    stepIntakeSemantics: STEP_INTAKE_SEMANTICS,
    ...(globalEventSummaryWork ? { globalEventSummaryWork } : {}),
  };
}

function buildRecordStepSyncV2(dependencies = {}) {
  const publishSummaryWake = dependencies.publishSummaryWake ||
    (() => redisCache.publishDurableQueueWakeup("summary"));
  const publishResolutionWake = dependencies.publishResolutionWake ||
    (() => redisCache.publishDurableQueueWakeup("resolution"));
  const prisma = dependencies.prisma || defaultPrisma;
  const stepSyncRequestModel = dependencies.StepSyncRequest || defaultStepSyncRequestModel;
  const stepInputIntake = dependencies.stepInputIntake || defaultStepInputIntake;
  const events = dependencies.eventBus || defaultEventBus;
  const appSettings = dependencies.appSettings || defaultAppSettings;
  const now = dependencies.now || (() => new Date());
  const maxWaitMs = dependencies.maxWaitMs ?? DEFAULT_MAX_WAIT_MS;
  const pollMs = dependencies.pollMs ?? DEFAULT_POLL_MS;
  const stampLastStepSyncAt = dependencies.prisma
    ? (userId, at) => prisma.user.update({
      where: { id: userId },
      data: { lastStepSyncAt: at },
    })
    : (userId, at) => lastStepSyncWriteBatch.stamp({ prisma, userId, at });

  async function runIntakeTransaction(work) {
    for (let attempt = 0; attempt < CAPTURE_CLOSURE_RETRIES; attempt += 1) {
      const startedAt = process.hrtime.bigint();
      try {
        // Explicit dependency and race fences inside the transaction provide
        // the summary-capture consistency boundary. Read Committed lets a
        // shared race queue row wait for its current writer and then merge the
        // latest committed generation instead of aborting on a stale snapshot.
        return await prisma.$transaction(work, { timeout: 15_000, maxWait: 10_000 });
      } catch (error) {
        markStepTelemetryTransactionError(error);
        if (!isSummaryCaptureClosureChanged(error) ||
            attempt === CAPTURE_CLOSURE_RETRIES - 1) {
          throw error;
        }
      } finally {
        recordStepTelemetryPhase(
          "transaction_total",
          Number(process.hrtime.bigint() - startedAt) / 1e6,
        );
      }
    }
    return null;
  }

  async function queueOptions() {
    const burstCoalescing = await isStrictFlagEnabled(
      appSettings, "raceResolutionBurstCoalescingV1Enabled",
    );
    const queuedGenerationMerge = await isStrictFlagEnabled(
      appSettings, "raceResolutionQueuedGenerationMergeV1Enabled",
    );
    return { burstCoalescing, queuedGenerationMerge };
  }

  async function stampAfterCommit({ userId, date, alreadyStamped = false }) {
    if (!alreadyStamped) {
      try {
        await stampLastStepSyncAt(userId, now());
      } catch (error) {
        console.error("sync-v2 lastStepSyncAt update failed:", error);
      }
    }
    try {
      await require("../services/dailyStepsCache").invalidateSafe(userId, date);
    } catch (error) {
      console.error("sync-v2 daily cache invalidation failed:", error);
    }
  }

  async function emitEventOnce(reservationId, payload) {
    try {
      if (await stepSyncRequestModel.claimEventsEmission(reservationId, now())) {
        events.emit(payload.dailyExisted ? "STEPS_UPDATED" : "STEPS_RECORDED", {
          userId: payload.userId,
          steps: payload.steps,
          date: payload.date,
        });
      }
    } catch (error) {
      console.error("sync-v2 step event emission failed:", error);
    }
  }

  async function runIntakeInTransaction({
    tx,
    reservation,
    userId,
    timeZone,
    canonical,
    cleaned,
    options,
  }) {
    const requestedAt = now();
    const summaryCaptureDependencies = await measureStepTelemetryPhase(
      "summary_finalization",
      () => require("../services/globalEventSummaryCapture")
        .lockEligibleSummaryCaptureDependencies(tx, {
          userId,
          at: requestedAt,
        }),
    );
    coordinatedOptimizationMetrics.increment("global_summary_capture_lookup_total");
    coordinatedOptimizationMetrics.observe("global_summary_capture_lookup_per_sync", 1);
    const intake = await stepInputIntake({
      userId,
      daily: { date: canonical.date, steps: canonical.steps },
      samples: cleaned,
      timeZone,
      requestTimestamp: requestedAt,
      endpoint: "sync-v2",
      ...options,
    }, tx);
    const completedAt = intake.completedAt || requestedAt;
    const globalEventSummaryWork = await measureStepTelemetryPhase(
      "summary_finalization",
      () => require("../services/globalEventSummaryCapture")
        .claimEligibleSummaryWork(tx, {
          userId,
          captureDependencies: summaryCaptureDependencies,
          captureSyncRequestId: reservation.id,
          captureCompletedAt: completedAt,
          captureCoverageThrough: intake.canonicalCoverageThrough,
          sourceScoringInputGeneration: intake.generation,
        }),
    );
    const response = buildResponse({
      record: intake.record,
      sampleCount: cleaned.length,
      jobs: intake.jobs,
      requestedAt,
      globalEventSummaryWork,
    });
    await measureStepTelemetryPhase(
      "summary_finalization",
      () => stepSyncRequestModel.finalize(
        {
          id: reservation.id,
          responseJson: response,
          dailyExisted: intake.dailyExisted,
          completedAt,
          canonicalCoverageThrough: intake.canonicalCoverageThrough,
          scoringInputGeneration: intake.generation,
          now: completedAt,
        },
        tx,
      ),
    );
    return {
      response,
      reservationId: reservation.id,
      dailyExisted: intake.dailyExisted,
      lastStepSyncStamped: intake.lastStepSyncStamped === true,
    };
  }

  async function afterCommit(result, { userId, canonical }) {
    await measureStepTelemetryPhase("post_commit", async () => {
      if (result.response?.raceResolution?.jobId) await publishResolutionWake();
      if (result.response?.globalEventSummaryWork) await publishSummaryWake();
      await stampAfterCommit({
        userId,
        date: canonical.date,
        alreadyStamped: result.lastStepSyncStamped,
      });
      void emitEventOnce(result.reservationId, {
        userId,
        date: canonical.date,
        steps: canonical.steps,
        dailyExisted: result.dailyExisted,
      });
    });
  }

  async function recover({ reservation, userId, timeZone, canonical, cleaned }) {
    const options = await queueOptions();
    const result = await runIntakeTransaction(async (tx) => {
      const claimed = await tx.stepSyncRequest.updateMany({
        where: {
          id: reservation.id,
          state: "PROCESSING",
          OR: [{ leaseExpiresAt: null }, { leaseExpiresAt: { lte: now() } }],
        },
        data: { leaseExpiresAt: new Date(now().getTime() + RECONCILE_LEASE_MS) },
      });
      if (claimed.count !== 1) return null;
      return runIntakeInTransaction({
        tx,
        reservation,
        userId,
        timeZone: reservation.resolutionTimeZone || timeZone,
        canonical,
        cleaned,
        options,
      });
    });
    if (!result) return null;
    releaseStepAdmission();
    await afterCommit(result, { userId, canonical });
    return result.response;
  }

  async function replayExisting({
    reservation,
    userId,
    idempotencyKey,
    timeZone,
    canonical,
    cleaned,
    hash,
  }) {
    if (reservation.requestHash !== hash) throw new StepSyncConflictError();
    if (reservation.state === "COMPLETE") {
      if (typeof reservation.dailyExisted === "boolean") {
        await emitEventOnce(reservation.id, {
          userId,
          date: canonical.date,
          steps: canonical.steps,
          dailyExisted: reservation.dailyExisted,
        });
      }
      return reservation.responseJson;
    }
    const deadline = now().getTime() + maxWaitMs;
    let current = reservation;
    while (now().getTime() < deadline) {
      if (!current.leaseExpiresAt ||
          new Date(current.leaseExpiresAt).getTime() <= now().getTime()) {
        const recovered = await recover({
          reservation: current, userId, timeZone, canonical, cleaned,
        });
        if (recovered) return recovered;
      }
      await sleep(pollMs);
      current = await stepSyncRequestModel.findByKey(userId, idempotencyKey);
      if (!current) return null;
      if (current.state === "COMPLETE") {
        return replayExisting({
          reservation: current, userId, idempotencyKey, timeZone,
          canonical, cleaned, hash,
        });
      }
    }
    const recovered = await recover({
      reservation: current, userId, timeZone, canonical, cleaned,
    });
    if (recovered) return recovered;
    const final = await stepSyncRequestModel.findByKey(userId, idempotencyKey);
    if (final?.state === "COMPLETE") {
      return replayExisting({
        reservation: final, userId, idempotencyKey, timeZone,
        canonical, cleaned, hash,
      });
    }
    return null;
  }

  return async function recordStepSyncV2({
    userId,
    body,
    idempotencyKey,
    timeZone = "UTC",
    homePull = false,
  }) {
    validateIdempotencyKey(idempotencyKey);
    const { canonical, hash } = canonicalizeStepSyncRequest(body);
    const cleaned = removeOverlaps(normalizeSamples(canonical.samples));

    const options = await queueOptions();
    let result;
    try {
      result = await runIntakeTransaction(async (tx) => {
        // First transactional write: a same-key loser cannot perform source
        // work before the reservation's unique constraint turns it away.
        const reservation = await stepSyncRequestModel.createReservation({
          userId,
          idempotencyKey,
          requestHash: hash,
          resolutionTimeZone: timeZone,
          leaseMs: RECONCILE_LEASE_MS,
          now: now(),
        }, tx);

        if (homePull) {
          const stamped = await tx.$queryRaw`
            UPDATE "users"
               SET "last_home_pull_step_sync_at" = CURRENT_TIMESTAMP
             WHERE "id" = ${userId}
               AND ("last_home_pull_step_sync_at" IS NULL OR
                    "last_home_pull_step_sync_at" <=
                      CURRENT_TIMESTAMP - INTERVAL '30 seconds')
            RETURNING "last_home_pull_step_sync_at" AS "lastHomePullStepSyncAt"
          `;
          if (stamped.length !== 1) {
            const cooldown = await tx.$queryRaw`
              SELECT CEIL(EXTRACT(EPOCH FROM (
                "last_home_pull_step_sync_at" + INTERVAL '30 seconds' - CURRENT_TIMESTAMP
              )))::int AS "retryAfterSeconds"
                FROM "users" WHERE "id" = ${userId}
            `;
            throw new StepSyncCooldownError(cooldown[0]?.retryAfterSeconds);
          }
        }

        return runIntakeInTransaction({
          tx, reservation, userId, timeZone, canonical, cleaned, options,
        });
      });
    } catch (error) {
      if (error?.code !== "P2002") {
        releaseStepAdmission();
        throw error;
      }
      try {
        const winner = await stepSyncRequestModel.findByKey(userId, idempotencyKey);
        if (!winner) throw error;
        const replay = await replayExisting({
          reservation: winner, userId, idempotencyKey, timeZone,
          canonical, cleaned, hash,
        });
        if (!replay) throw error;
        return replay;
      } finally {
        releaseStepAdmission();
      }
    }

    releaseStepAdmission();
    await afterCommit(result, { userId, canonical });
    return result.response;
  };
}

const recordStepSyncV2 = buildRecordStepSyncV2();

module.exports = {
  buildRecordStepSyncV2,
  recordStepSyncV2,
  StepSyncValidationError,
  StepSyncConflictError,
  StepSyncCooldownError,
  STEP_INTAKE_SEMANTICS,
  HOME_PULL_COOLDOWN_SECONDS,
};
