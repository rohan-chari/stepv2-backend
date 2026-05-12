const { prisma } = require("../db");

const PowerupUpgradeEvent = {
  async create({ raceId, userId, powerupId, powerupType, tier, costCoins, status, targetUserId = null }) {
    return prisma.powerupUpgradeEvent.create({
      data: { raceId, userId, powerupId, powerupType, tier, costCoins, status, targetUserId },
    });
  },

  async findByPowerup(powerupId) {
    return prisma.powerupUpgradeEvent.findMany({
      where: { powerupId },
      orderBy: { createdAt: "asc" },
    });
  },

  async findByUser(userId) {
    return prisma.powerupUpgradeEvent.findMany({
      where: { userId },
      orderBy: { createdAt: "desc" },
    });
  },
};

module.exports = { PowerupUpgradeEvent };
