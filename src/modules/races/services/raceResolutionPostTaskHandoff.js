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

  return async function handoff({
    raceId,
    sourceGeneration,
    snapshotCommand,
    intents = [],
    resolveIntents = null,
  }) {
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
      task = await model.create({
        raceId,
        sourceGeneration,
        snapshotCommand,
        intents,
        resolveIntents,
      });
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
    if (!(await runner.isReady())) {
      await runner.processTaskId(task.id);
      return { mode: "inline_claim", taskId: task.id };
    }
    return { mode: "queued", taskId: task.id };
  };
}

const raceResolutionPostTaskHandoff = buildRaceResolutionPostTaskHandoff();

module.exports = {
  buildRaceResolutionPostTaskHandoff,
  raceResolutionPostTaskHandoff,
};
