const { prisma: defaultPrisma } = require("../../../db");
const { scheduleEntitlements } = require("../services/globalEventRedisSchedule");

async function hydrateGlobalEventRedisSchedule({
  prisma = defaultPrisma,
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
            endsAt: { gt: current, lte: horizon },
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

    const boundaries = [];
    for (const row of rows) {
      // scheduleEntitlements writes both edges. Keeping already-processed edges
      // in the sorted set would create harmless duplicate work, so only hydrate
      // rows whose START is still pending. END-only recovery is written directly
      // below.
      if (!row.startProcessedAt) {
        boundaries.push(row);
      } else if (!row.endProcessedAt && new Date(row.endsAt) <= horizon) {
        // For an already-started entitlement, add only END.
        const { withCommandClient } = require("../../../shared/queues/redisStreams");
        const { scheduleKey, boundaryMember } = require("../services/globalEventRedisSchedule");
        await withCommandClient((redis) => redis.zadd(
          scheduleKey(),
          new Date(row.endsAt).getTime(),
          boundaryMember("END", row),
        ));
        scheduled += 1;
      }
    }
    if (boundaries.length) {
      await scheduleEntitlements(boundaries);
      scheduled += boundaries.length * 2;
    }
    cursor = rows.at(-1).id;
    if (rows.length < take) break;
  }

  return { scheduled };
}

module.exports = { hydrateGlobalEventRedisSchedule };
