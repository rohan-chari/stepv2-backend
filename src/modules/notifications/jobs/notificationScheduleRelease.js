const {
  notificationIntentService: defaultNotificationIntentService,
} = require("../services/notificationDelivery");
const redisCache = require("../../../shared/cache/redisCache");

const FALLBACK_INTERVAL_MS = 60_000;
const RECOVERY_INTERVAL_MS = 60_000;
const MAX_DUE_TIMER_MS = 60_000;

function buildNotificationScheduleRelease(dependencies = {}) {
  const service = dependencies.notificationIntentService || defaultNotificationIntentService;
  const now = dependencies.now || (() => new Date());
  const batchSize = Math.min(500, Math.max(1, Number(dependencies.batchSize) || 500));
  return async function releaseNotificationSchedules() {
    await dependencies.startupBarrier?.();
    const totals = { released: 0, materialized: 0, expired: 0, canceled: 0, batches: 0 };
    for (;;) {
      const admitted = await service.releaseEventNotificationPage({ now: now(), maximumRows: batchSize });
      totals.batches += 1;
      totals.materialized += admitted.materialized || 0;
      totals.released += admitted.materialized || 0;
      totals.expired += admitted.expired || 0;
      if ((admitted.examined || 0) < batchSize) break;
      await new Promise((resolve) => setImmediate(resolve));
    }
    for (;;) {
      const page = await service.releaseDue({ now: now(), batchSize });
      totals.batches += 1;
      totals.released += page.released || 0;
      totals.expired += page.expired || 0;
      totals.canceled += page.canceled || 0;
      if ((page.released || 0) + (page.expired || 0) + (page.canceled || 0) < batchSize) break;
      await new Promise((resolve) => setImmediate(resolve));
    }
    return totals;
  };
}

function scheduleNotificationScheduleRelease(dependencies = {}) {
  const service = dependencies.notificationIntentService || defaultNotificationIntentService;
  const run = dependencies.run || buildNotificationScheduleRelease({
    ...dependencies,
    notificationIntentService: service,
  });
  const nextDueAt = dependencies.nextDueAt || service.nextDueAt;
  const subscribeWakeup = dependencies.subscribeNotificationWakeup ||
    redisCache.subscribeNotificationWakeup;
  const logger = dependencies.logger || console;
  const nowMs = dependencies.nowMs || Date.now;
  const setDueTimer = dependencies.setDueTimer || setTimeout;
  const clearDueTimer = dependencies.clearDueTimer || clearTimeout;
  let stopped = false;
  let running = null;
  let rerun = false;
  let dueTimer = null;
  let unsubscribe = null;
  const armDueTimer = async () => {
    if (stopped || typeof nextDueAt !== "function") return;
    const dueAt = await nextDueAt();
    if (dueTimer) clearDueTimer(dueTimer);
    dueTimer = null;
    if (!dueAt) return;
    const untilDue = new Date(dueAt).getTime() - nowMs();
    // This is an eligibility timer, not polling. Work that is already due is
    // drained on the next event-loop turn; future work sleeps until its exact
    // boundary (bounded by the 60s recovery interval).
    const delay = Math.max(0, Math.min(MAX_DUE_TIMER_MS, untilDue));
    dueTimer = setDueTimer(tick, delay);
    dueTimer.unref?.();
  };
  const tick = () => {
    if (stopped) return running;
    if (running) { rerun = true; return running; }
    running = (async () => {
      let result;
      do {
        rerun = false;
        result = await run();
        await armDueTimer();
      } while (rerun && !stopped);
      return result;
    })()
      .catch((error) => {
        logger.error?.("[NOTIFICATION] schedule release failed", {
          errorCode: error?.code || "SCHEDULE_RELEASE_FAILED",
        });
        if (!stopped) {
          if (dueTimer) clearDueTimer(dueTimer);
          dueTimer = setDueTimer(tick, 1_000);
          dueTimer.unref?.();
        }
      })
      .finally(() => { running = null; });
    return running;
  };
  tick();
  const interval = setInterval(tick, dependencies.intervalMs || RECOVERY_INTERVAL_MS);
  interval.unref?.();
  Promise.resolve(subscribeWakeup(() => tick()))
    .then((stop) => { unsubscribe = stop; })
    .catch((error) => logger.error?.("[NOTIFICATION] schedule wake subscription failed", {
      errorCode: error?.code || "SCHEDULE_WAKE_SUBSCRIBE_FAILED",
    }));
  return {
    tick,
    async stop() {
      if (stopped) return;
      stopped = true;
      clearInterval(interval);
      if (dueTimer) clearDueTimer(dueTimer);
      await unsubscribe?.();
      await running;
    },
  };
}

module.exports = {
  FALLBACK_INTERVAL_MS,
  RECOVERY_INTERVAL_MS,
  buildNotificationScheduleRelease,
  scheduleNotificationScheduleRelease,
};
