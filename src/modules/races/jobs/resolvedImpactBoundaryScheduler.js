const { prisma: defaultPrisma } = require("../../../db");
const {
  RaceResolutionJobV2: defaultJobModel,
} = require("../models/raceResolutionJobV2");
const redisCache = require("../../../shared/cache/redisCache");

const POLL_INTERVAL_MS = 1000;
const DEFAULT_LIMIT = 50;

function shouldResolveUmbrellaImpacts(job) {
  return Boolean(
    job?.processingDirtyReasons?.includes("EFFECT_BOUNDARY") &&
    job?.processingDirtyPowerupTypes?.includes("UMBRELLA")
  );
}

function buildResolvedImpactBoundaryScheduler(dependencies = {}) {
  const prisma = dependencies.prisma || defaultPrisma;
  const jobModel = dependencies.RaceResolutionJobV2 || defaultJobModel;
  const now = dependencies.now || (() => new Date());
  const limit = Math.max(1, Math.min(200, Number(dependencies.limit) || DEFAULT_LIMIT));
  const publishResolutionWake = dependencies.publishResolutionWake ||
    (() => redisCache.publishDurableQueueWakeup(
      "resolution", { workKind: "ordinary" },
    ));

  return {
    async tick() {
      // The partial (resolves_at,race_id,id) pending index makes this a bounded
      // domain-boundary probe. It runs outside ordinary race resolution, so a
      // no-due score generation performs zero active-impact-specific queries.
      const rows = await prisma.$queryRawUnsafe(
        `SELECT race_id AS "raceId"
           FROM race_umbrella_interceptions
          WHERE status = 'PENDING'
            AND resolves_at <= $1::timestamp
          GROUP BY race_id
          ORDER BY MIN(resolves_at), race_id
          LIMIT $2`,
        now(),
        limit,
      );
      const raceIds = [...new Set(rows.map((row) => row.raceId).filter(Boolean))].sort();
      if (raceIds.length === 0) return 0;
      const dirtyEnvelopeByRaceId = new Map(raceIds.map((raceId) => [raceId, {
        reason: "EFFECT_BOUNDARY",
        dirtyUserIds: [],
        dirtyParticipantIds: [],
        powerupTypes: ["UMBRELLA"],
        priority: "IMMEDIATE",
      }]));
      await jobModel.enqueueMany({
        raceIds,
        now: now(),
        dirtyEnvelopeByRaceId,
        bypassDebounce: true,
      });
      await publishResolutionWake();
      return raceIds.length;
    },
  };
}

function scheduleResolvedImpactBoundaryScheduler({ logger = console } = {}) {
  const scheduler = buildResolvedImpactBoundaryScheduler();
  const tick = () => scheduler.tick().catch((error) =>
    logger.error("[RESOLVED_IMPACT_BOUNDARY] tick failed", error));
  tick();
  const timer = setInterval(tick, POLL_INTERVAL_MS);
  timer.unref?.();
  return timer;
}

module.exports = {
  POLL_INTERVAL_MS,
  buildResolvedImpactBoundaryScheduler,
  scheduleResolvedImpactBoundaryScheduler,
  shouldResolveUmbrellaImpacts,
};
