const {
  notificationIntentService: defaultNotificationIntentService,
} = require("../services/notificationDelivery");
const redisCache = require("../../../shared/cache/redisCache");

const FALLBACK_INTERVAL_MS = 5_000;
const MIN_DUE_RETRY_MS = 1_000;
const MAX_DUE_TIMER_MS = 60_000;

function buildNotificationScheduleRelease(dependencies = {}) {
  const service = dependencies.notificationIntentService || defaultNotificationIntentService;
  const now = dependencies.now || (() => new Date());
  const batchSize = Math.min(500, Math.max(1, Number(dependencies.batchSize) || 500));
  return async function releaseNotificationSchedules() {
    const totals = { released: 0, expired: 0, canceled: 0, batches: 0 };
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
  let stopped = false;
  let running = null;
  let dueTimer = null;
  let unsubscribe = null;
  const armDueTimer = async () => {
    if (stopped || typeof nextDueAt !== "function") return;
    const dueAt = await nextDueAt();
    if (dueTimer) clearTimeout(dueTimer);
    dueTimer = null;
    if (!dueAt) return;
    const untilDue = new Date(dueAt).getTime() - Date.now();
    const delay = Math.max(
      dependencies.minDueRetryMs || MIN_DUE_RETRY_MS,
      Math.min(MAX_DUE_TIMER_MS, untilDue),
    );
    dueTimer = setTimeout(tick, delay);
    dueTimer.unref?.();
  };
  const tick = () => {
    if (stopped || running) return running;
    running = Promise.resolve()
      .then(run)
      .then(async (result) => {
        await armDueTimer();
        return result;
      })
      .catch((error) => logger.error?.("[NOTIFICATION] schedule release failed", {
        errorCode: error?.code || "SCHEDULE_RELEASE_FAILED",
      }))
      .finally(() => { running = null; });
    return running;
  };
  tick();
  const interval = setInterval(tick, dependencies.intervalMs || FALLBACK_INTERVAL_MS);
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
      if (dueTimer) clearTimeout(dueTimer);
      await unsubscribe?.();
      await running;
    },
  };
}

module.exports = {
  FALLBACK_INTERVAL_MS,
  buildNotificationScheduleRelease,
  scheduleNotificationScheduleRelease,
};
