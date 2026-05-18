const { prisma } = require("../db");

function applyCursor(where, cursor) {
  if (!cursor) return;

  if (typeof cursor === "object" && cursor.createdAt) {
    const createdAt = new Date(cursor.createdAt);
    if (Number.isNaN(createdAt.getTime())) return;

    if (cursor.kind === "USER") {
      where.OR = [{ createdAt: { lt: createdAt } }, { createdAt }];
      return;
    }

    if (cursor.kind === "SYSTEM" && cursor.id) {
      where.OR = [
        { createdAt: { lt: createdAt } },
        { createdAt, id: { lt: cursor.id } },
      ];
      return;
    }

    where.createdAt = { lt: createdAt };
    return;
  }

  const createdAt = new Date(cursor);
  if (!Number.isNaN(createdAt.getTime())) {
    where.createdAt = { lt: createdAt };
  }
}

const RacePowerupEvent = {
  async create({ raceId, actorUserId, eventType, powerupType, targetUserId, description, metadata }) {
    return prisma.racePowerupEvent.create({
      data: { raceId, actorUserId, eventType, powerupType, targetUserId, description, metadata },
    });
  },

  async findByRace(raceId, { cursor, limit = 50 } = {}) {
    const where = { raceId };
    applyCursor(where, cursor);
    return prisma.racePowerupEvent.findMany({
      where,
      orderBy: [{ createdAt: "desc" }, { id: "desc" }],
      take: limit,
    });
  },

  async findByRaceAsc(raceId) {
    return prisma.racePowerupEvent.findMany({
      where: { raceId },
      orderBy: { createdAt: "asc" },
    });
  },
};

module.exports = { RacePowerupEvent };
