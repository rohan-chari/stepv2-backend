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

  async rebaseDecoyConsumedMany({
    db = prisma,
    raceId,
    consumptions,
    consumedAt,
    nextUsableAt,
  }) {
    const uniqueByUser = new Map();
    for (const consumption of consumptions || []) {
      if (!consumption?.userId) continue;
      uniqueByUser.set(consumption.userId, consumption);
    }
    const rows = [...uniqueByUser.values()];
    if (!rows.length) return { count: 0 };

    const userIds = rows.map((row) => row.userId);
    const updated = await db.powerupUsageState.updateMany({
      where: {
        raceId,
        powerupType: "DECOY",
        userId: { in: userIds },
      },
      data: {
        activeUntil: consumedAt,
        nextUsableAt,
      },
    });

    await db.powerupUsageState.createMany({
      data: rows.map((row) => ({
        raceId,
        userId: row.userId,
        powerupType: "DECOY",
        lastUsedAt: consumedAt,
        activeUntil: consumedAt,
        nextUsableAt,
        sourcePowerupId: row.sourcePowerupId || null,
      })),
      skipDuplicates: true,
    });

    return updated;
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
