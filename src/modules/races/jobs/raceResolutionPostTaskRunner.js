const {
  RaceResolutionPostTask: defaultPostTaskModel,
} = require("../models/raceResolutionPostTask");
const {
  raceResolutionWorkBudget: defaultWorkBudget,
} = require("../services/raceResolutionWorkBudget");
const {
  raceProgressPostCommit,
} = require("../services/raceProgressSideEffects");
const {
  RaceResolutionJobV2: defaultJobModel,
} = require("../models/raceResolutionJobV2");
const {
  raceResolutionDeliveryIntents: defaultDeliveryIntents,
} = require("../services/raceResolutionDeliveryIntents");
const { appSettings: defaultAppSettings } = require("../../../shared/config/appSettings");
const { isStrictFlagEnabled } = require("../../../shared/config/isStrictFlagEnabled");
const {
  destructiveCleanupDisabled,
  raceResolutionPostTaskWorkerDisabled,
} = require("../../../shared/config/operationalControls");
const {
  recoverReferralQualificationIntents,
} = require("../../giveaways/jobs/qualificationIntentRecovery");
const {
  expireEffects: defaultExpireEffects,
} = require("../../powerups/commands/expireEffects");
const { createPostgresWakeCoordinator } = require("../../../shared/queues/postgresWakeCoordinator");
const {
  isReceiptCleanupCutoffAccepted: defaultIsReceiptCleanupCutoffAccepted,
} = require("../../../shared/queues/receiptCleanupCutoff");
const redisCache = require("../../../shared/cache/redisCache");
const { prisma: defaultPrisma } = require("../../../db");
const { createReceiptCleanupBudget } = require("../../../shared/queues/receiptCleanupBudget");

const POLL_INTERVAL_MS = 30_000;
const RECOVERY_INTERVAL_MS = 30_000;
const CLEANUP_INTERVAL_MS = 10 * 60 * 1000;
const CLEANUP_BATCH_SIZE = 500;
const CLEANUP_MAX_BATCHES = 2;
const ADAPTIVE_DRAIN_SLICE_MS = 100;
const ADAPTIVE_DRAIN_SLICE_TASKS = 16;
const ADAPTIVE_DRAIN_ERROR_BACKOFF_MS = 1000;

function postTaskWorkerDisabled(env = process.env) {
  return raceResolutionPostTaskWorkerDisabled(env);
}

function postTaskCleanupDisabled(env = process.env) {
  return destructiveCleanupDisabled(
    "RACE_RESOLUTION_POST_TASK_CLEANUP_DISABLED",
    env,
  );
}

function buildRaceResolutionPostTaskRunner(dependencies = {}) {
  const model = dependencies.RaceResolutionPostTask || defaultPostTaskModel;
  const deliverIntent =
    dependencies.deliverIntent || ((intent) => defaultDeliveryIntents.deliver(intent));
  const publishSnapshot =
    dependencies.publishSnapshot ||
    ((command, task) => raceProgressPostCommit.publishSnapshotCommand(command, task));
  const expireEffects = dependencies.expireEffects || defaultExpireEffects;
  const jobModel = dependencies.RaceResolutionJobV2 || defaultJobModel;
  const isSuperseded =
    dependencies.isSuperseded ||
    (async (task) => {
      const job = await jobModel.findByRaceId(task.raceId);
      return Boolean(
        job &&
          Number(job.processingGeneration) > Number(task.sourceGeneration) &&
          job.lastCompletedAt
      );
    });
  const now = dependencies.now || (() => new Date());
  const logger = dependencies.logger || console;
  const env = dependencies.env || process.env;
  const cleanupBatchSize = Math.max(
    1,
    Math.min(CLEANUP_BATCH_SIZE, Number(dependencies.cleanupBatchSize) || CLEANUP_BATCH_SIZE),
  );
  const cleanupMaxBatches = Math.max(
    1,
    Math.min(CLEANUP_MAX_BATCHES, Number(dependencies.cleanupMaxBatches) || CLEANUP_MAX_BATCHES),
  );
  const cleanupBudgetFactory = dependencies.cleanupBudgetFactory || (() =>
    dependencies.cleanupBudget || (dependencies.RaceResolutionPostTask
      ? { async runPage(operation) { return { rows: await operation(), allowedContinue: true }; } }
      : createReceiptCleanupBudget({ prisma: dependencies.prisma || defaultPrisma })));
  const yieldToEventLoop = dependencies.yieldToEventLoop ||
    (() => new Promise((resolve) => setImmediate(resolve)));
  const workBudget = dependencies.raceResolutionWorkBudget || defaultWorkBudget;
  const isReceiptCleanupCutoffAccepted =
    dependencies.isReceiptCleanupCutoffAccepted ||
    (dependencies.RaceResolutionPostTask
      ? async () => false
      : defaultIsReceiptCleanupCutoffAccepted);
  const recoverQualificationIntents =
    dependencies.recoverReferralQualificationIntents ||
    (dependencies.RaceResolutionPostTask
      ? async () => ({ processed: 0, remaining: 0 })
      : () => recoverReferralQualificationIntents());
  let lastSuccessfulClaimProbeAt = null;
  let positiveReadinessCachedUntilMs = 0;

  function invalidateReadinessCache() {
    positiveReadinessCachedUntilMs = 0;
  }

  async function processIntent(intent) {
    if (intent.state !== "pending") return;
    const attemptId = await model.beginIntent({ id: intent.id, now: now() });
    if (!attemptId) return;
    if (!intent.recipientUserId) {
      await model.completeIntent({
        id: intent.id,
        state: "rejected_no_retry",
        providerDisposition: "RECIPIENT_DELETED",
        errorCode: "RECIPIENT_DELETED",
        now: now(),
      });
      return;
    }
    try {
      const result = await deliverIntent(intent, { attemptId });
      await model.completeIntent({
        id: intent.id,
        state: result?.accepted === true ? "accepted" : "rejected_no_retry",
        providerDisposition: result?.disposition || null,
        errorCode: result?.accepted === true ? null : "PROVIDER_REJECTED",
        now: now(),
      });
    } catch {
      // Provider I/O failure is inherently ambiguous. At-most-once means record
      // it terminal immediately and never resend it from a later lease.
      await model.completeIntent({
        id: intent.id,
        state: "ambiguous_at_most_once",
        errorCode: "PROVIDER_IO_AMBIGUOUS",
        now: now(),
      });
    }
  }

  async function processSnapshot(task) {
    if (task.snapshotState && task.snapshotState !== "pending") return;
    const {
      effectExpiryParticipantSteps = null,
      ...snapshotCommand
    } = task.snapshotCommand || {};
    // Effect convergence is retryable and runs before the snapshot's
    // at-most-once attempt marker. If the worker dies here, the task lease is
    // reclaimed with snapshot_state still pending and expiry is retried from
    // the authoritative generation payload.
    if (effectExpiryParticipantSteps) {
      await expireEffects({
        raceId: task.raceId,
        participantSteps: effectExpiryParticipantSteps,
        taskFence: { taskId: task.id, leaseToken: task.leaseToken },
      });
    }
    const attemptId = await model.beginSnapshot({
      taskId: task.id,
      leaseToken: task.leaseToken,
      now: now(),
    });
    if (!attemptId) return;
    if (await isSuperseded(task)) {
      await model.completeSnapshot({ taskId: task.id, state: "skipped_superseded", now: now() });
      return;
    }
    try {
      const published = await publishSnapshot(snapshotCommand, task, { attemptId });
      await model.completeSnapshot({
        taskId: task.id,
        state: published === false ? "failed_no_retry" : "succeeded",
        errorCode: published === false ? "SNAPSHOT_NOT_PUBLISHED" : null,
        now: now(),
      });
    } catch {
      await model.completeSnapshot({
        taskId: task.id,
        state: "ambiguous_at_most_once",
        errorCode: "SNAPSHOT_IO_AMBIGUOUS",
        now: now(),
      });
    }
  }

  async function processClaimedTask(task) {
    if (!task) return null;
    const intents = await model.listIntents(task.id);
    const beforeSnapshot = intents.filter((intent) =>
      ["STATE_NOTIFICATION", "EFFECT_NOTIFICATION"].includes(intent.kind)
    );
    const afterSnapshot = intents.filter((intent) =>
      ["NUDGE", "STEP_SYNC"].includes(intent.kind)
    );
    for (const intent of beforeSnapshot) await processIntent(intent);
    await processSnapshot(task);
    for (const intent of afterSnapshot) await processIntent(intent);
    const state = await model.finish({
      taskId: task.id,
      leaseToken: task.leaseToken,
      now: now(),
    });
    if (!state) logger.error("[RACE_RESOLUTION_POST_TASK] task did not reach terminal state");
    return { taskId: task.id, state };
  }

  return {
    isDisabled() {
      return postTaskWorkerDisabled(env);
    },
    async tick() {
      if (postTaskWorkerDisabled(env)) return null;
      try {
        return await workBudget.run("post", async () => {
          const task = await model.claimNext({ now: now() });
          lastSuccessfulClaimProbeAt = now();
          return processClaimedTask(task);
        });
      } catch (error) {
        invalidateReadinessCache();
        throw error;
      }
    },
    async processTaskId(id) {
      if (postTaskWorkerDisabled(env)) return null;
      try {
        const task = await model.claimById({ id, now: now() });
        lastSuccessfulClaimProbeAt = now();
        return processClaimedTask(task);
      } catch (error) {
        invalidateReadinessCache();
        throw error;
      }
    },
    async isReady({ positiveCacheMs = 0 } = {}) {
      if (postTaskWorkerDisabled(env) || !lastSuccessfulClaimProbeAt) return false;
      const currentTime = now();
      if (currentTime.getTime() < positiveReadinessCachedUntilMs) return true;
      if (currentTime.getTime() - lastSuccessfulClaimProbeAt.getTime() > 60_000) {
        invalidateReadinessCache();
        return false;
      }
      let health;
      try {
        health = await model.readinessSnapshot({ now: currentTime });
      } catch (error) {
        invalidateReadinessCache();
        throw error;
      }
      const ready = Number(health?.oldestPendingLagMs || 0) < 30_000 &&
        Number(health?.expiredAttemptCount || 0) === 0;
      if (ready && positiveCacheMs > 0) {
        positiveReadinessCachedUntilMs = currentTime.getTime() +
          Math.min(1000, Math.max(0, Number(positiveCacheMs) || 0));
      } else if (!ready) {
        invalidateReadinessCache();
      }
      return ready;
    },
    async cleanup() {
      if (postTaskCleanupDisabled(env)) return 0;
      // WAL, latency, replica-lag, and stop state are per maintenance run.
      // A stopped page must resume on the next tick rather than latching until
      // the Node process restarts.
      const cleanupBudget = cleanupBudgetFactory();
      const cutoffAccepted = await isReceiptCleanupCutoffAccepted();
      const retentionMs = (cutoffAccepted ? 1 : 7) * 24 * 60 * 60 * 1000;
      const before = new Date(now().getTime() - retentionMs);
      let deleted = 0;
      for (let batch = 0; batch < cleanupMaxBatches; batch += 1) {
        const pageResult = await cleanupBudget.runPage(() => model.cleanupTerminal({
          before, limit: cleanupBatchSize,
        }));
        const pageDeleted = pageResult.rows;
        deleted += pageDeleted;
        if (!pageResult.allowedContinue || pageDeleted < cleanupBatchSize) break;
        if (batch + 1 < cleanupMaxBatches) await yieldToEventLoop();
      }
      return deleted;
    },
  };
}

const raceResolutionPostTaskRunner = buildRaceResolutionPostTaskRunner();

function scheduleRaceResolutionPostTaskRunner(dependencies = {}) {
  const env = dependencies.env || process.env;
  if (postTaskWorkerDisabled(env)) return null;
  const runner = Object.keys(dependencies).length === 0
    ? raceResolutionPostTaskRunner
    : buildRaceResolutionPostTaskRunner(dependencies);
  const settings = dependencies.appSettings || defaultAppSettings;
  const yieldToEventLoop = dependencies.yieldToEventLoop ||
    (() => new Promise((resolve) => setImmediate(resolve)));
  const drainSliceMs = Math.max(
    1,
    Number(dependencies.adaptiveDrainSliceMs) || ADAPTIVE_DRAIN_SLICE_MS
  );
  const drainSliceTasks = Math.max(
    1,
    Number(dependencies.adaptiveDrainSliceTasks) || ADAPTIVE_DRAIN_SLICE_TASKS
  );
  const errorBackoffMs = Math.max(
    POLL_INTERVAL_MS,
    Number(dependencies.adaptiveDrainErrorBackoffMs) ||
      ADAPTIVE_DRAIN_ERROR_BACKOFF_MS
  );
  let running = false;
  let cleanupRunning = null;
  let backoffUntilMs = 0;
  const adaptiveDrainEnabled = () => isStrictFlagEnabled(
    settings,
    "raceResolutionPostTaskAdaptiveDrainV1Enabled"
  );
  async function runScheduledWork() {
    if (running || postTaskWorkerDisabled(env)) return;
    running = true;
    let adaptive = false;
    try {
      adaptive = await adaptiveDrainEnabled();
      if (adaptive && Date.now() < backoffUntilMs) return;
      if (!adaptive) {
        await runner.tick();
        return;
      }

      let sliceStartedAt = Date.now();
      let sliceTasks = 0;
      for (;;) {
        if (postTaskWorkerDisabled(env)) return;
        const processed = await runner.tick();
        if (!processed) return;
        sliceTasks += 1;
        if (
          sliceTasks >= drainSliceTasks ||
          Date.now() - sliceStartedAt >= drainSliceMs
        ) {
          await yieldToEventLoop();
          if (
            postTaskWorkerDisabled(env) ||
            !(await adaptiveDrainEnabled())
          ) return;
          sliceStartedAt = Date.now();
          sliceTasks = 0;
        }
      }
    } catch (error) {
      if (adaptive) {
        backoffUntilMs = Date.now() + errorBackoffMs;
        (dependencies.logger || console).error(
          "[RACE_RESOLUTION_POST_TASK] adaptive tick failed:",
          error
        );
        error.retryAfterMs = Math.max(Number(error.retryAfterMs) || 0, errorBackoffMs);
      } else {
        (dependencies.logger || console).error(
          "[RACE_RESOLUTION_POST_TASK] tick failed:",
          error
        );
      }
      throw error;
    } finally {
      running = false;
    }
  }
  const coordinator = createPostgresWakeCoordinator({
    queue: "post-task",
    fallbackIntervalMs: dependencies.pollIntervalMs || RECOVERY_INTERVAL_MS,
    drain: runScheduledWork,
    nextDueAt: () => runner.isDisabled() ? null : modelNextDueAt(runner, dependencies),
    subscribeWake: dependencies.subscribeWake || redisCache.subscribeDurableQueueWakeup,
    logger: dependencies.logger || console,
  });
  coordinator.start({ drainOnStart: dependencies.drainOnStart !== false }).catch((error) => (dependencies.logger || console).error(
    "[RACE_RESOLUTION_POST_TASK] wake coordinator failed", error,
  ));
  const interval = null;
  const runCleanup = () => {
    if (cleanupRunning) return cleanupRunning;
    cleanupRunning = runner.cleanup().catch((error) => {
      (dependencies.logger || console).error(
        "[RACE_RESOLUTION_POST_TASK] cleanup failed:",
        error
      );
    }).finally(() => { cleanupRunning = null; });
    return cleanupRunning;
  };
  const cleanup = setInterval(runCleanup, dependencies.cleanupIntervalMs || CLEANUP_INTERVAL_MS);
  cleanup.unref?.();
  const qualificationRecovery = setInterval(() => {
    recoverQualificationIntents().catch((error) => (dependencies.logger || console).error(
      "[RACE_RESOLUTION_POST_TASK] qualification recovery failed", error,
    ));
  }, dependencies.qualificationRecoveryIntervalMs || 60_000);
  qualificationRecovery.unref?.();
  return {
    interval, cleanup, qualificationRecovery, runner, runCleanup, coordinator,
    async stop() {
      clearInterval(cleanup);
      clearInterval(qualificationRecovery);
      await coordinator.stop();
    },
  };
}

async function modelNextDueAt(runner, dependencies) {
  const model = dependencies.RaceResolutionPostTask || defaultPostTaskModel;
  return typeof model.nextDueAt === "function" ? model.nextDueAt() : null;
}

module.exports = {
  POLL_INTERVAL_MS,
  RECOVERY_INTERVAL_MS,
  CLEANUP_INTERVAL_MS,
  CLEANUP_BATCH_SIZE,
  CLEANUP_MAX_BATCHES,
  postTaskCleanupDisabled,
  postTaskWorkerDisabled,
  buildRaceResolutionPostTaskRunner,
  raceResolutionPostTaskRunner,
  scheduleRaceResolutionPostTaskRunner,
};
