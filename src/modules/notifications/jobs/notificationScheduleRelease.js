const {
  notificationIntentService: defaultNotificationIntentService,
} = require("../services/notificationDelivery");

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
  const run = dependencies.run || buildNotificationScheduleRelease(dependencies);
  const logger = dependencies.logger || console;
  let stopped = false;
  let running = null;
  let timer = null;
  const tick = () => {
    if (stopped || running) return running;
    running = run().catch((error) => logger.error?.("[NOTIFICATION] schedule release failed", {
      errorCode: error?.code || "SCHEDULE_RELEASE_FAILED",
    })).finally(() => { running = null; });
    return running;
  };
  const arm = (delay) => {
    if (stopped) return;
    timer = setTimeout(async () => { await tick(); arm(dependencies.intervalMs || 250); }, delay);
    timer.unref?.();
  };
  tick();
  arm(dependencies.intervalMs || 250);
  return { tick, async stop() { stopped = true; if (timer) clearTimeout(timer); await running; } };
}

module.exports = { buildNotificationScheduleRelease, scheduleNotificationScheduleRelease };
