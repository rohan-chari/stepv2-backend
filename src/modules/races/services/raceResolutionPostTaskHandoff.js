const {
  RaceResolutionPostTask: defaultPostTaskModel,
} = require("../models/raceResolutionPostTask");
const {
  raceResolutionPostTaskRunner: defaultRunner,
} = require("../jobs/raceResolutionPostTaskRunner");
const {
  raceProgressPostCommit,
} = require("./raceProgressSideEffects");
const {
  raceResolutionDeliveryIntents,
} = require("./raceResolutionDeliveryIntents");
const redisCache = require("../../../shared/cache/redisCache");

function buildRaceResolutionPostTaskHandoff(dependencies = {}) {
  const model = dependencies.RaceResolutionPostTask || defaultPostTaskModel;
  const runner = dependencies.runner || defaultRunner;
  const publishSnapshotInline =
    dependencies.publishSnapshotInline ||
    ((command) => raceProgressPostCommit.publishSnapshotCommand(command));
  const logger = dependencies.logger || console;
  const deliverIntentInline =
    dependencies.deliverIntentInline ||
    ((intent) => raceResolutionDeliveryIntents.deliver(intent));
  const publishWake = dependencies.publishWake ||
    (() => redisCache.publishDurableQueueWakeup("post-task"));

  async function executeInline(snapshotCommand, intents) {
    const before = intents.filter((intent) =>
      ["STATE_NOTIFICATION", "EFFECT_NOTIFICATION"].includes(intent.kind)
    );
    const after = intents.filter((intent) =>
      ["NUDGE", "STEP_SYNC"].includes(intent.kind)
    );
    for (const intent of before) {
      try { await deliverIntentInline(intent); } catch {}
    }
    try { await publishSnapshotInline(snapshotCommand); } catch {}
    for (const intent of after) {
      try { await deliverIntentInline(intent); } catch {}
    }
  }

  const handoff = async function handoff({
    raceId,
    sourceGeneration,
    snapshotCommand,
    intents = [],
    resolveIntents = null,
    fastHandoff = false,
    recordPhaseTiming = null,
  }) {
    const measure = async (name, operation) => {
      if (typeof recordPhaseTiming !== "function") return operation();
      const startedAt = process.hrtime.bigint();
      try {
        return await operation();
      } finally {
        try {
          recordPhaseTiming(
            name,
            Math.max(0, Number(process.hrtime.bigint() - startedAt) / 1e6)
          );
        } catch {}
      }
    };
    if (!snapshotCommand) return { mode: "none", taskId: null };
    if (typeof runner.isDisabled === "function" && runner.isDisabled()) {
      // The kill switch intentionally retains the legacy inline delivery
      // path. There is no durable owner in this mode, so resolve claims using
      // the legacy service transaction before delivering them.
      const inlineIntents = typeof resolveIntents === "function"
        ? await resolveIntents(null)
        : intents;
      await executeInline(snapshotCommand, inlineIntents);
      return { mode: "inline_disabled", taskId: null };
    }
    let task;
    try {
      task = await measure(
        "taskTransaction",
        () => model.create({
          raceId,
          sourceGeneration,
          snapshotCommand,
          intents,
          resolveIntents,
          fastHandoff,
          recordPhaseTiming,
        })
      );
    } catch (error) {
      // A transaction error can be returned after a server-side commit. Never
      // blindly replay its notification decisions: first prove that this
      // generation has no durable owner. If the probe itself is unavailable,
      // leave delivery untouched (the existing owner remains runner-recoverable)
      // rather than violate at-most-once delivery.
      let existing;
      try {
        existing = typeof model.findByGeneration === "function"
          ? await model.findByGeneration({ raceId, sourceGeneration })
          : null;
      } catch (probeError) {
        logger.error(JSON.stringify({
          event: "race_resolution_post_handoff",
          outcome: "ownership_unknown",
          errorCode: probeError?.code || probeError?.name || "TASK_PROBE_FAILED",
        }));
        return { mode: "ownership_unknown", taskId: null };
      }
      if (existing?.id) return { mode: "durable_after_error", taskId: existing.id };
      logger.error(JSON.stringify({
        event: "race_resolution_post_handoff",
        outcome: "inline_fallback",
        errorCode: error?.code || error?.name || "TASK_CREATE_FAILED",
      }));
      const inlineIntents = typeof resolveIntents === "function"
        ? await resolveIntents(null)
        : intents;
      await executeInline(snapshotCommand, inlineIntents);
      return { mode: "inline_fallback", taskId: null };
    }

    // A duplicate generation already has one durable owner. Never execute a
    // second inline copy of its publication or intents.
    if (!task?.created) return { mode: "deduped", taskId: task?.id || null };
    await publishWake();
    if (!(await measure("runnerReadiness", () => runner.isReady({
      positiveCacheMs: fastHandoff ? 1000 : 0,
    })))) {
      await measure("inlineClaim", () => runner.processTaskId(task.id));
      return { mode: "inline_claim", taskId: task.id };
    }
    return { mode: "queued", taskId: task.id };
  };

  // The resolution worker uses this seam from inside its fenced authoritative
  // transaction.  The post-task owner and every immutable delivery decision
  // therefore become visible atomically with recordSuccess; a watchdog exit
  // after commit can never strand a succeeded generation without its handoff.
  handoff.supportsAtomicDurableCreate =
    dependencies.supportsAtomicDurableCreate ?? model === defaultPostTaskModel;
  handoff.createDurable = async function createDurable(input, tx) {
    if (!handoff.supportsAtomicDurableCreate || !tx) {
      throw new Error("atomic durable post-task creation unavailable");
    }
    return model.create(input, tx);
  };
  handoff.resumeDurable = async function resumeDurable(taskId, {
    fastHandoff = false,
    recordPhaseTiming = null,
  } = {}) {
    if (!taskId) return { mode: "none", taskId: null };
    await publishWake();
    const measure = async (name, operation) => {
      if (typeof recordPhaseTiming !== "function") return operation();
      const startedAt = process.hrtime.bigint();
      try { return await operation(); } finally {
        try {
          recordPhaseTiming(
            name,
            Math.max(0, Number(process.hrtime.bigint() - startedAt) / 1e6)
          );
        } catch {}
      }
    };
    if (!(await measure("runnerReadiness", () => runner.isReady({
      positiveCacheMs: fastHandoff ? 1000 : 0,
    })))) {
      await measure("inlineClaim", () => runner.processTaskId(taskId));
      return { mode: "inline_claim", taskId };
    }
    return { mode: "queued", taskId };
  };
  return handoff;
}

const raceResolutionPostTaskHandoff = buildRaceResolutionPostTaskHandoff();

module.exports = {
  buildRaceResolutionPostTaskHandoff,
  raceResolutionPostTaskHandoff,
};
