const { prisma: defaultPrisma } = require("../../../db");
const { invalidate } = require("../../../shared/cache/derivedCache");
const cacheKeys = require("../../../shared/cache/cacheKeys");

// Idempotently aggregate only event/user groups with no pending enrollment.
// Enrollment/final delta rows are written by the canonical settlement writer;
// this worker intentionally never recomputes score math from live samples.
function buildGlobalEventSummaryTick(dependencies = {}) {
  const prisma = dependencies.prisma || defaultPrisma;
  const now = dependencies.now || (() => new Date());
  return async function globalEventSummaryTick() {
    if (process.env.GLOBAL_EVENT_SUMMARY_DISABLED === "true") return null;
    const groups = await prisma.globalEventRaceImpact.groupBy({
      by: ["eventId", "userId"],
      _sum: { deltaSteps: true }, _count: { _all: true },
      where: { status: "FINAL" },
    });
    let upserts = 0;
    for (const group of groups) {
      // A user can join/start another race later in a still-open event. Do not
      // mint an immutable recap until that enrollment window has closed.
      const event = await prisma.globalStepEvent.findUnique({
        where: { id: group.eventId },
        select: { endsAt: true },
      });
      if (!event || new Date(event.endsAt).getTime() > now().getTime()) continue;
      const pending = await prisma.globalEventRaceImpact.count({
        where: { eventId: group.eventId, userId: group.userId, status: { not: "FINAL" } },
      });
      if (pending) continue;
      // The job_runs insert and summary upsert share one transaction. A crash
      // rolls BOTH back; a concurrent worker loses the unique job_name claim,
      // so retry/resume cannot double-deliver or strand a partial summary.
      const jobName = `global_event_summary:${group.eventId}:${group.userId}:v1`;
      let committed = false;
      try {
        await prisma.$transaction(async (tx) => {
          await tx.jobRun.create({ data: { jobName, lastRanFor: "FINAL" } });
          await tx.globalEventUserSummary.upsert({
            where: { eventId_userId: { eventId: group.eventId, userId: group.userId } },
            update: {},
            create: {
              eventId: group.eventId, userId: group.userId,
              extraRaceSteps: group._sum.deltaSteps || 0, raceCount: group._count._all,
              settledAt: now(),
            },
          });
        });
        committed = true;
      } catch (error) {
        if (error?.code !== "P2002") throw error;
      }
      if (committed) {
        await invalidate({
          keys: [cacheKeys.homeImpactSummary(group.userId)],
          prefix: cacheKeys.PREFIX.HOME_IMPACT_SUMMARY,
        });
        upserts += 1;
      }
    }
    return { upserts };
  };
}

function scheduleGlobalEventSummaryTick(dependencies = {}) {
  const run = buildGlobalEventSummaryTick(dependencies);
  const logger = dependencies.logger || console;
  const tick = () => run().catch((error) => logger.error("[CRON] globalEventSummary tick error:", error));
  tick();
  const interval = setInterval(tick, dependencies.intervalMs || 5 * 60 * 1000);
  interval.unref?.();
  logger.log("[CRON] Global event summary scheduled");
}

module.exports = { buildGlobalEventSummaryTick, scheduleGlobalEventSummaryTick };
