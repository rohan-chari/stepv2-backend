const { prisma } = require("../../../db");

// A user's GLOBAL powerup inventory (one row per [userId, powerupType]).
const UserPowerupItem = {
  async findManyByUser(userId) {
    return prisma.userPowerupItem.findMany({
      where: { userId },
      orderBy: { powerupType: "asc" },
    });
  },

  async findOne(userId, powerupType) {
    return prisma.userPowerupItem.findUnique({
      where: { userId_powerupType: { userId, powerupType } },
    });
  },

  // Atomic conditional decrement of 1: succeeds (count 1) only when quantity
  // >= 1, so a user can never spend a powerup they don't own.
  async decrementIfAvailable(userId, powerupType) {
    return prisma.userPowerupItem.updateMany({
      where: { userId, powerupType, quantity: { gte: 1 } },
      data: { quantity: { decrement: 1 } },
    });
  },
};

module.exports = { UserPowerupItem };
