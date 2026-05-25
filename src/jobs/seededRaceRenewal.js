const { prisma: defaultPrisma } = require("../db");

const RENEWAL_INTERVAL_MS = 5 * 60 * 1000; // every 5 minutes

function buildRenewSeededRaces(dependencies = {}) {
  const prisma = dependencies.prisma || defaultPrisma;
  const now = dependencies.now || (() => new Date());
  const logger = dependencies.logger || console;

  return async function renewSeededRaces() {
    const activeSeeds = await prisma.raceSeed.findMany({
      where: { active: true },
    });

    if (activeSeeds.length === 0) return [];

    const created = [];
    for (const seed of activeSeeds) {
      const liveRace = await prisma.race.findFirst({
        where: {
          seedId: seed.id,
          status: { in: ["PENDING", "ACTIVE"] },
        },
        select: { id: true },
      });

      if (liveRace) continue;

      const startedAt = now();

      try {
        const race = await prisma.race.create({
          data: {
            seedId: seed.id,
            creatorId: null,
            name: seed.name,
            targetSteps: seed.targetSteps,
            status: "ACTIVE",
            isPublic: true,
            maxParticipants: seed.maxParticipants,
            startedAt,
          },
          select: { id: true, name: true },
        });
        created.push({ seedKind: seed.kind, race });
        logger.log(
          `[CRON] Seeded race created for ${seed.kind}: ${race.id} ("${race.name}")`
        );
      } catch (error) {
        logger.error(
          `[CRON] Failed to create seeded race for ${seed.kind}:`,
          error
        );
      }
    }

    return created;
  };
}

const renewSeededRaces = buildRenewSeededRaces();

function scheduleSeededRaceRenewal(dependencies = {}) {
  const interval = dependencies.intervalMs || RENEWAL_INTERVAL_MS;
  const logger = dependencies.logger || console;
  const renewFn = dependencies.renewSeededRaces || renewSeededRaces;

  async function run() {
    try {
      await renewFn();
    } catch (error) {
      logger.error("[CRON] Seeded race renewal error:", error);
    }
  }

  run();
  setInterval(run, interval);
  logger.log(`[CRON] Seeded race renewal scheduled (every ${interval / 1000}s)`);
}

module.exports = {
  buildRenewSeededRaces,
  renewSeededRaces,
  scheduleSeededRaceRenewal,
  RENEWAL_INTERVAL_MS,
};
