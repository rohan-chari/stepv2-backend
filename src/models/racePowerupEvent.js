const { prisma } = require("../db");

const RacePowerupEvent = {
  async create({ raceId, actorUserId, eventType, powerupType, targetUserId, description, metadata }) {
    return prisma.racePowerupEvent.create({
      data: { raceId, actorUserId, eventType, powerupType, targetUserId, description, metadata },
    });
  },

  async findByRace(raceId, { cursor, limit = 50 } = {}) {
    const where = { raceId };
    if (cursor) {
      where.createdAt = { lt: new Date(cursor) };
    }
    return prisma.racePowerupEvent.findMany({
      where,
      orderBy: { createdAt: "desc" },
      take: limit,
    });
  },
};

module.exports = { RacePowerupEvent };
