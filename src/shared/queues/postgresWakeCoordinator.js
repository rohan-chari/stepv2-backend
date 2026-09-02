const MAX_TIMER_MS = 2_147_483_647;
const {
  coordinatedOptimizationMetrics: defaultMetrics,
} = require("../observability/coordinatedOptimizationMetrics");

function createPostgresWakeCoordinator({
  queue,
  fallbackIntervalMs,
  drain,
  nextDueAt = async () => null,
  subscribeWake = async () => async () => {},
  logger = console,
  now = () => new Date(),
  setTimer = setTimeout,
  clearTimer = clearTimeout,
  metrics = defaultMetrics,
}) {
  if (!queue || typeof drain !== "function") {
    throw new TypeError("queue and drain are required");
  }
  const fallbackMs = Math.max(1, Number(fallbackIntervalMs) || 1);
  let stopped = false;
  let started = false;
  let running = null;
  let rerun = false;
  let pendingReason = null;
  let fallbackTimer = null;
  let dueTimer = null;
  let failureBackoffUntilMs = 0;
  let unsubscribe = async () => {};
  const reasonPriority = { wake: 0, due: 1, startup: 2, fallback: 3 };

  function retainHigherPriorityReason(current, candidate) {
    if (!current) return candidate;
    return (reasonPriority[candidate] ?? 0) > (reasonPriority[current] ?? 0)
      ? candidate
      : current;
  }

  function cancelTimer(timer) {
    if (timer) clearTimer(timer);
  }

  function armFallback() {
    cancelTimer(fallbackTimer);
    if (stopped) return;
    fallbackTimer = setTimer(() => {
      fallbackTimer = null;
      requestDrain("fallback");
      armFallback();
    }, fallbackMs);
    fallbackTimer.unref?.();
  }

  async function rearmDueTimer() {
    cancelTimer(dueTimer);
    dueTimer = null;
    if (stopped) return;
    let dueAt;
    try {
      dueAt = await nextDueAt();
    } catch (error) {
      logger.error(`[DURABLE_QUEUE:${queue}] next-due lookup failed`, error);
      if (!stopped) {
        dueTimer = setTimer(() => {
          dueTimer = null;
          rearmDueTimer();
        }, 1_000);
        dueTimer.unref?.();
      }
      return;
    }
    if (!dueAt) return;
    const timestamp = new Date(dueAt).getTime();
    if (!Number.isFinite(timestamp)) return;
    const delay = Math.min(MAX_TIMER_MS, Math.max(0, timestamp - now().getTime()));
    dueTimer = setTimer(() => {
      dueTimer = null;
      requestDrain("due");
    }, delay);
    dueTimer.unref?.();
  }

  function requestDrain(_reason = "wake") {
    if (stopped) return Promise.resolve();
    const currentMs = now().getTime();
    if (!running && currentMs < failureBackoffUntilMs) {
      pendingReason = retainHigherPriorityReason(pendingReason, _reason);
      if (!dueTimer) {
        const delay = Math.max(1_000, failureBackoffUntilMs - currentMs);
        dueTimer = setTimer(() => {
          dueTimer = null;
          failureBackoffUntilMs = 0;
          const reason = pendingReason || "due";
          pendingReason = null;
          requestDrain(reason);
        }, delay);
        dueTimer.unref?.();
      }
      return Promise.resolve();
    }
    if (running) {
      rerun = true;
      pendingReason = retainHigherPriorityReason(pendingReason, _reason);
      if (_reason === "wake") {
        metrics.increment("durable_queue_wake_coalesced_total", { queue });
      }
      return running;
    }
    if (_reason === "wake") {
      metrics.increment("durable_queue_wake_received_total", { queue });
    } else if (_reason === "fallback") {
      metrics.increment("durable_queue_fallback_poll_total", { queue, found_work: "unknown" });
    }
    running = (async () => {
      do {
        rerun = false;
        const reason = pendingReason || _reason;
        pendingReason = null;
        cancelTimer(dueTimer);
        dueTimer = null;
        let drainFailed = false;
        try {
          await drain({ reason });
        } catch (error) {
          logger.error(`[DURABLE_QUEUE:${queue}] drain failed`, error);
          const retryAfterMs = Math.max(1_000, Number(error?.retryAfterMs) || 0);
          failureBackoffUntilMs = now().getTime() + retryAfterMs;
          pendingReason = retainHigherPriorityReason(pendingReason, reason);
          rerun = false;
          dueTimer = setTimer(() => {
            dueTimer = null;
            failureBackoffUntilMs = 0;
            const retryReason = pendingReason || "due";
            pendingReason = null;
            requestDrain(retryReason);
          }, retryAfterMs);
          dueTimer.unref?.();
          drainFailed = true;
        }
        // Rearming performs a PostgreSQL read. A Redis wake can arrive while
        // that read is in flight; keep it inside the rerun loop so that wake
        // owns an immediate follow-up drain instead of being lost until the
        // fallback timer.
        if (!drainFailed && !rerun && !stopped) await rearmDueTimer();
      } while (rerun && !stopped);
    })().finally(() => { running = null; });
    return running;
  }

  return {
    queue,
    async start({ drainOnStart = true } = {}) {
      if (started) return this;
      started = true;
      stopped = false;
      try {
        unsubscribe = await subscribeWake((message) => {
          if (!message || !message.queue || message.queue === queue) {
            requestDrain("wake");
          }
        });
      } catch (error) {
        logger.error(`[DURABLE_QUEUE:${queue}] wake subscription failed`, error);
      }
      armFallback();
      if (drainOnStart) await requestDrain("startup");
      else await rearmDueTimer();
      return this;
    },
    requestDrain,
    rearmDueTimer,
    async whenIdle() {
      while (running) await running;
    },
    async stop() {
      stopped = true;
      cancelTimer(fallbackTimer);
      cancelTimer(dueTimer);
      fallbackTimer = null;
      dueTimer = null;
      await unsubscribe();
      await this.whenIdle();
    },
  };
}

module.exports = { createPostgresWakeCoordinator };
