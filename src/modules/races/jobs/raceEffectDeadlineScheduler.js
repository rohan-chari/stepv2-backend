const {
  RaceEffectDeadline,
  isBusyRaceJobError,
} = require("../models/raceEffectDeadline");
const redisCache = require("../../../shared/cache/redisCache");
const {
  startCapacityPhase,
} = require("../../../shared/observability/capacityPhaseMetrics");
const POLL_INTERVAL_MS = 1000;
function buildRaceEffectDeadlineScheduler(dependencies = {}) {
  const model = dependencies.RaceEffectDeadline || RaceEffectDeadline;
  const wake =
    dependencies.publishResolutionWake ||
    (() =>
      redisCache.publishDurableQueueWakeup("resolution", {
        workKind: "ordinary",
      }));
  const busyUntil = new Map();
  let lastHealthAt = 0;
  return {
    async tick() {
      const metric = startCapacityPhase("effect_deadline_dispatch");
      let count = 0;
      let outcome = "error";
      try {
        if (
          Date.now() - lastHealthAt >= 60000 &&
          typeof model.health === "function"
        ) {
          lastHealthAt = Date.now();
          const health = await model.health();
          for (const kind of ["pending", "dispatched"]) {
            const lag = health?.[kind]
              ? Math.max(0, Date.now() - new Date(health[kind]).getTime())
              : 0;
            require("../services/raceEffectExpiryTelemetry").observeExpiryStage(
              `oldest_${kind}`,
              lag,
            );
            if (lag > 30000)
              (dependencies.logger || console).warn(
                "[EFFECT_DEADLINE] overdue work",
                { kind, ageMs: lag },
              );
          }
        }
        for (const [id, until] of busyUntil)
          if (until <= Date.now()) busyUntil.delete(id);
        const rows = await model.due({ afterRaceIds: [...busyUntil.keys()] });
        for (const raceId of [...new Set(rows.map((r) => r.race_id))]) {
          try {
            const result = await model.dispatchRace(raceId);
            if (result) {
              count++;
              require("../services/raceEffectExpiryTelemetry").observeExpiryStage(
                "deadline_to_dispatch",
                Date.now() - new Date(result.effects[0].deadline_at).getTime(),
                {
                  raceId,
                  generation: result.job.generation,
                  effects: result.effects,
                },
              );
              await wake();
            } else {
              // Cancelled/ended/racing source rows must not occupy the due
              // head until the slower cleanup sweep removes them.
              busyUntil.set(raceId, Date.now() + 5000);
            }
          } catch (error) {
            if (!isBusyRaceJobError(error)) throw error;
            busyUntil.set(raceId, Date.now() + 5000);
          }
          await new Promise((resolve) => setImmediate(resolve));
        }
        await require("../models/raceProgressRefreshIntent").drainProgressRefreshIntents();
        await require("../models/raceSnapshotRepairIntent").drainSnapshotRepairs();
        metric.setCounts({ candidates: rows.length, dispatchedRaces: count });
        outcome = "success";
        return count;
      } finally {
        metric.finish(outcome);
      }
    },
    async recover() {
      await require("../models/raceSnapshotRepairIntent").censusSnapshotRepairs();
      return model.recover();
    },
  };
}
function scheduleRaceEffectDeadlineScheduler(dependencies = {}) {
  const scheduler = buildRaceEffectDeadlineScheduler(dependencies);
  let running = false;
  const tick = async () => {
    if (running) return;
    running = true;
    try {
      await scheduler.tick();
    } catch (e) {
      (dependencies.logger || console).error(
        "[EFFECT_DEADLINE] tick failed",
        e,
      );
    } finally {
      running = false;
    }
  };
  const timer = setInterval(tick, POLL_INTERVAL_MS);
  timer.unref?.();
  tick();
  const unsubscribe = redisCache.subscribeDurableQueueWakeup((signal) => {
    if (signal?.queue === "resolution") tick();
  });
  scheduler
    .recover()
    .catch((e) =>
      (dependencies.logger || console).error(
        "[EFFECT_DEADLINE] startup recovery failed",
        e,
      ),
    );
  const recovery = setInterval(
    () =>
      scheduler
        .recover()
        .catch((e) =>
          (dependencies.logger || console).error(
            "[EFFECT_DEADLINE] recovery failed",
            e,
          ),
        ),
    300000,
  );
  recovery.unref?.();
  return {
    scheduler,
    async stop() {
      clearInterval(timer);
      clearInterval(recovery);
      await (
        await unsubscribe
      )();
    },
  };
}
module.exports = {
  POLL_INTERVAL_MS,
  buildRaceEffectDeadlineScheduler,
  scheduleRaceEffectDeadlineScheduler,
};
