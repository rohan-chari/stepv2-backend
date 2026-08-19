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

const POLL_INTERVAL_MS = 250;
const CLEANUP_INTERVAL_MS = 60 * 60 * 1000;

function postTaskWorkerDisabled(env = process.env) {
  return env.RACE_RESOLUTION_POST_TASK_WORKER_DISABLED === "true";
}

function postTaskCleanupDisabled(env = process.env) {
  return env.RACE_RESOLUTION_POST_TASK_CLEANUP_DISABLED === "true";
}

function buildRaceResolutionPostTaskRunner(dependencies = {}) {
  const model = dependencies.RaceResolutionPostTask || defaultPostTaskModel;
  const deliverIntent =
    dependencies.deliverIntent || ((intent) => defaultDeliveryIntents.deliver(intent));
  const publishSnapshot =
    dependencies.publishSnapshot ||
    ((command) => raceProgressPostCommit.publishSnapshotCommand(command));
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
  const workBudget = dependencies.raceResolutionWorkBudget || defaultWorkBudget;
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
      const published = await publishSnapshot(task.snapshotCommand, task, { attemptId });
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
      return model.cleanupTerminal({
        before: new Date(now().getTime() - 7 * 24 * 60 * 60 * 1000),
        limit: 500,
      });
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
  let running = false;
  const interval = setInterval(async () => {
    if (running || postTaskWorkerDisabled(env)) return;
    running = true;
    try {
      await runner.tick();
    } catch (error) {
      (dependencies.logger || console).error("[RACE_RESOLUTION_POST_TASK] tick failed:", error);
    } finally {
      running = false;
    }
  }, dependencies.pollIntervalMs || POLL_INTERVAL_MS);
  interval.unref?.();
  const cleanup = setInterval(() => {
    runner.cleanup().catch((error) => {
      (dependencies.logger || console).error(
        "[RACE_RESOLUTION_POST_TASK] cleanup failed:",
        error
      );
    });
  }, dependencies.cleanupIntervalMs || CLEANUP_INTERVAL_MS);
  cleanup.unref?.();
  return { interval, cleanup, runner };
}

module.exports = {
  POLL_INTERVAL_MS,
  CLEANUP_INTERVAL_MS,
  postTaskCleanupDisabled,
  postTaskWorkerDisabled,
  buildRaceResolutionPostTaskRunner,
  raceResolutionPostTaskRunner,
  scheduleRaceResolutionPostTaskRunner,
};
