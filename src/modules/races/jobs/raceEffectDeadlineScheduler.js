const {
  RaceEffectDeadline,
  isBusyRaceJobError,
} = require("../models/raceEffectDeadline");
const redisCache = require("../../../shared/cache/redisCache");
const {
  publish: publishStream,
  STREAMS,
} = require("../../../shared/queues/redisStreams");
const { RACE_DIRTY_VERSION } = require("../../../shared/queues/workMessages");
const {
  startCapacityPhase,
} = require("../../../shared/observability/capacityPhaseMetrics");
const { coordinatedOptimizationMetrics: metrics } = require("../../../shared/observability/coordinatedOptimizationMetrics");
const POLL_INTERVAL_MS = 1000;
const MAX_BUSY_RACES = 1000;
const metricLabels = { queue: "effect-deadline" };
function buildRaceEffectDeadlineScheduler(dependencies = {}) {
  const now = dependencies.now || Date.now;
  const model = dependencies.RaceEffectDeadline || RaceEffectDeadline;
  const publishRaceDirty =
    dependencies.publishRaceDirty ||
    (async (job) => {
      if (!job?.raceId) return null;
      return publishStream(STREAMS.RACE_DIRTY, {
        schemaVersion: RACE_DIRTY_VERSION,
        raceId: job.raceId,
        userId: "",
        sourceGeneration: job.generation ? String(job.generation) : "",
        jobGeneration: job.generation ? String(job.generation) : "",
        reason: "EFFECT_BOUNDARY",
        requestedAt: new Date(now()).toISOString(),
      });
    });
  const busyUntil = new Map();
  let lastHealthAt = 0;
  let saturated = false;
  let traversalCursor = null;
  function markBusy(raceId) {
    if (!busyUntil.has(raceId) && busyUntil.size >= MAX_BUSY_RACES) {
      saturated = true;
      busyUntil.delete(busyUntil.keys().next().value);
    }
    busyUntil.set(raceId, now() + 5000);
    if (busyUntil.size >= MAX_BUSY_RACES) saturated = true;
  }
  return {
    async tick({ isStopped = () => false, trigger = "direct" } = {}) {
      const metric = startCapacityPhase("effect_deadline_dispatch");
      const startedAt = performance.now();
      let count = 0;
      let outcome = "error";
      try {
        if (
          now() - lastHealthAt >= 60000 &&
          typeof model.health === "function"
        ) {
          lastHealthAt = now();
          const health = await model.health();
          for (const kind of ["pending", "dispatched"]) {
            const lag = health?.[kind]
              ? Math.max(0, now() - new Date(health[kind]).getTime())
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
          if (until <= now()) busyUntil.delete(id);
        if (isStopped()) return 0;
        const discovery = typeof model.peekDueSchedulerWork === "function"
          ? await model.peekDueSchedulerWork({ afterRaceIds: [...busyUntil.keys()], traversalCursor, saturated })
          : { effects: await model.due({ afterRaceIds: [...busyUntil.keys()] }), refreshDue: true, repairDue: true };
        metrics.increment("deadline_scheduler_query_total", { kind: "discovery" });
        const rows = discovery.effects;
        for (const raceId of [...new Set(rows.map((r) => r.race_id))]) {
          if (isStopped()) break;
          try {
            const result = await model.dispatchRace(raceId);
            if (result) {
              count++;
              require("../services/raceEffectExpiryTelemetry").observeExpiryStage(
                "deadline_to_dispatch",
                now() - new Date(result.effects[0].deadline_at).getTime(),
                {
                  raceId,
                  generation: result.job.generation,
                  effects: result.effects,
                },
              );
              await publishRaceDirty(result.job);
            } else {
              // Cancelled/ended/racing source rows must not occupy the due
              // head until the slower cleanup sweep removes them.
              markBusy(raceId);
            }
          } catch (error) {
            if (!isBusyRaceJobError(error)) throw error;
            markBusy(raceId);
          }
          await new Promise((resolve) => setImmediate(resolve));
        }
        if (saturated && !isStopped()) {
          traversalCursor = discovery.tailExhausted ? null : discovery.nextTraversalCursor;
          if (discovery.tailExhausted && busyUntil.size < MAX_BUSY_RACES) saturated = false;
        }
        let refreshAdmitted = 0;
        const refreshInvoked = !isStopped() && (discovery.refreshDue || count > 0);
        if (refreshInvoked) refreshAdmitted = await require("../models/raceProgressRefreshIntent").drainProgressRefreshIntents();
        const repairInvoked = !isStopped() && (discovery.repairDue || count > 0 || refreshAdmitted > 0);
        if (refreshInvoked) metrics.increment("deadline_scheduler_drain_total", { kind: "refresh" });
        if (repairInvoked) metrics.increment("deadline_scheduler_drain_total", { kind: "repair" });
        if (repairInvoked) await require("../models/raceSnapshotRepairIntent").drainSnapshotRepairs();
        if (!rows.length && !refreshInvoked && !repairInvoked) metrics.increment("durable_queue_idle_poll_total", metricLabels);
        metric.setCounts({ candidates: rows.length, dispatchedRaces: count,
          refreshInvoked: Number(refreshInvoked), repairInvoked: Number(repairInvoked) });
        outcome = "success";
        return count;
      } finally {
        metric.finish(outcome);
        metrics.increment("deadline_scheduler_pass_total", { kind: trigger, outcome });
        metrics.observe("deadline_scheduler_pass_seconds", (performance.now() - startedAt) / 1000, { kind: trigger, outcome });
      }
    },
    async recover({ isStopped = () => false } = {}) {
      if (isStopped()) return;
      await require("../models/raceSnapshotRepairIntent").censusSnapshotRepairs();
      if (isStopped()) return;
      return model.recover({ isStopped });
    },
  };
}
function scheduleRaceEffectDeadlineScheduler(dependencies = {}) {
  const scheduler = dependencies.scheduler || buildRaceEffectDeadlineScheduler(dependencies);
  const interval = dependencies.setInterval || setInterval;
  const cancelInterval = dependencies.clearInterval || clearInterval;
  const immediate = dependencies.setImmediate || setImmediate;
  const cancelImmediate = dependencies.clearImmediate || clearImmediate;
  const subscribe = dependencies.subscribeDurableQueueWakeup || redisCache.subscribeDurableQueueWakeup;
  const logger = dependencies.logger || console;
  let stopped = false;
  let stopPromise;
  const pass = { running: null, pending: false, scheduled: null };
  const recoveryPass = { running: null, pending: false, scheduled: null };
  function schedulePending(state, method) {
    if (stopped || state.running || state.scheduled || !state.pending) return;
    state.scheduled = immediate(() => {
      state.scheduled = null;
      run(state, method);
    });
    state.scheduled?.unref?.();
  }
  function run(state, method) {
    if (stopped || state.running) return;
    state.pending = false;
    const trigger = state.trigger || "startup";
    state.trigger = null;
    // Install ownership before invoking user code, including synchronous throws.
    state.running = Promise.resolve().then(() => {
      if (!stopped) return scheduler[method]({ isStopped: () => stopped, trigger });
    }).catch(error => logger.error(`[EFFECT_DEADLINE] ${method} failed`, error))
      .finally(() => {
        state.running = null;
        schedulePending(state, method);
      });
  }
  function request(state, method, trigger) {
    if (stopped) return;
    if (state.running || state.pending || state.scheduled) {
      metrics.increment("durable_queue_wake_coalesced_total", { ...metricLabels, kind: trigger });
    }
    state.trigger = state.trigger && state.trigger !== trigger ? "mixed" : trigger;
    state.pending = true;
    schedulePending(state, method);
  }
  const timer = interval(() => {
    metrics.increment("durable_queue_fallback_poll_total", metricLabels);
    request(pass, "tick", "timer");
  }, POLL_INTERVAL_MS);
  timer?.unref?.();
  const recovery = interval(() => request(recoveryPass, "recover", "recovery"), 300000);
  recovery?.unref?.();
  const unsubscribe = Promise.resolve(subscribe(signal => {
    if (signal?.queue !== "resolution") return;
    metrics.increment("durable_queue_wake_received_total", metricLabels);
    request(pass, "tick", "wake");
  })).catch(error => {
    logger.error("[EFFECT_DEADLINE] wake subscription failed", error);
    return async () => {};
  });
  run(pass, "tick");
  run(recoveryPass, "recover");
  return {
    scheduler,
    stop() {
      if (stopPromise) return stopPromise;
      stopped = true;
      cancelInterval(timer);
      cancelInterval(recovery);
      for (const state of [pass, recoveryPass]) {
        state.pending = false;
        if (state.scheduled) cancelImmediate(state.scheduled);
        state.scheduled = null;
      }
      const active = [pass.running, recoveryPass.running];
      stopPromise = (async () => {
        try { await (await unsubscribe)(); }
        finally { await Promise.allSettled(active); }
      })();
      return stopPromise;
    },
  };
}

module.exports = {
  POLL_INTERVAL_MS,
  buildRaceEffectDeadlineScheduler,
  scheduleRaceEffectDeadlineScheduler,
};
