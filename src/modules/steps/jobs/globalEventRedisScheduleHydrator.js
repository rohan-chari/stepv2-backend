async function hydrateGlobalEventRedisSchedule({
  prisma = require("../../../db").prisma,
  scheduleEntitlements = require("../services/globalEventRedisSchedule").scheduleEntitlements,
  now = new Date(),
  horizonEnd = new Date(new Date(now).getTime() + 72 * 60 * 60 * 1000),
  batchSize = 500,
} = {}) {
  const current = new Date(now);
  const horizon = new Date(horizonEnd);
  const take = Math.min(500, Math.max(1, Number(batchSize) || 500));
  let cursor = null;
  let scheduled = 0;

  for (;;) {
    const rows = await prisma.globalStepEventEntitlement.findMany({
      where: {
        ...(cursor ? { id: { gt: cursor } } : {}),
        OR: [
          {
            startProcessedAt: null,
            startsAt: { lte: horizon },
            endsAt: { gt: current },
          },
          {
            endProcessedAt: null,
            // Pending ENDs remain recoverable after their timestamp passes.
            endsAt: { lte: horizon },
          },
        ],
      },
      orderBy: { id: "asc" },
      take,
      select: {
        id: true,
        startsAt: true,
        endsAt: true,
        startProcessedAt: true,
        endProcessedAt: true,
        scheduleRevision: true,
      },
    });
    if (!rows.length) break;

    const starts = rows.filter((row) => !row.startProcessedAt);
    const ends = rows.filter((row) => row.startProcessedAt && !row.endProcessedAt);
    if (ends.length) {
      await scheduleEntitlements(ends, { start: false });
      scheduled += ends.length;
    }
    if (starts.length) {
      await scheduleEntitlements(starts);
      scheduled += starts.length * 2;
    }
    cursor = rows.at(-1).id;
    if (rows.length < take) break;
  }

  return { scheduled };
}

function scheduleGlobalEventRedisScheduleHydrator(dependencies = {}) {
  const run = dependencies.run || (() => hydrateGlobalEventRedisSchedule(dependencies));
  const logger = dependencies.logger || console;
  const intervalMs = Math.max(60_000, Number(dependencies.intervalMs) || 5 * 60_000);
  let stopped = false;
  let running = null;

  const tick = () => {
    if (stopped || running) return running;
    running = Promise.resolve()
      .then(run)
      .catch((error) => logger.error?.("[GLOBAL_EVENT_QUEUE] schedule hydration failed", error))
      .finally(() => { running = null; });
    return running;
  };

  void tick();
  const interval = setInterval(tick, intervalMs);
  interval.unref?.();
  return {
    tick,
    async stop() {
      stopped = true;
      clearInterval(interval);
      await running;
    },
  };
}

module.exports = {
  hydrateGlobalEventRedisSchedule,
  scheduleGlobalEventRedisScheduleHydrator,
};
