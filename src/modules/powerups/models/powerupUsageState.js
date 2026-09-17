const { prisma } = require("../../../db");

const PowerupUsageState = {
  async findForUpdate(db, raceId, userId, powerupType) {
    return (db || prisma).powerupUsageState.findUnique({
      where: { raceId_userId_powerupType: { raceId, userId, powerupType } },
    });
  },

  async findAvailable(db, raceId, userId, powerupType, now = new Date()) {
    return (db || prisma).powerupUsageState.findFirst({
      where: {
        raceId,
        userId,
        powerupType,
        nextUsableAt: { gt: now },
      },
      select: { nextUsableAt: true, activeUntil: true },
    });
  },

  async findForRaceUser(db, raceId, userId) {
    return (db || prisma).powerupUsageState.findMany({
      where: { raceId, userId },
      orderBy: { powerupType: "asc" },
    });
  },

  async upsertUsed({
    db = prisma,
    userId,
    raceId,
    powerupType,
    lastUsedAt,
    activeUntil = null,
    nextUsableAt,
    sourcePowerupId = null,
  }) {
    return db.powerupUsageState.upsert({
      where: { raceId_userId_powerupType: { raceId, userId, powerupType } },
      create: {
        userId,
        raceId,
        powerupType,
        lastUsedAt,
        activeUntil,
        nextUsableAt,
        sourcePowerupId,
      },
      update: {
        lastUsedAt,
        activeUntil,
        nextUsableAt,
        sourcePowerupId,
      },
    });
  },
};

module.exports = { PowerupUsageState };
