const { prisma } = require("../db");

const WeeklyChallenge = {
  async findByWeek(weekOf) {
    return prisma.weeklyChallenge.findUnique({
      where: { weekOf: new Date(weekOf) },
      include: { challenge: true },
    });
  },

  async create({ weekOf, challengeId }) {
    return prisma.weeklyChallenge.create({
      data: {
        weekOf: new Date(weekOf),
        challengeId,
      },
      include: { challenge: true },
    });
  },

  async markResolved(weekOf, resolvedAt) {
    return prisma.weeklyChallenge.update({
      where: { weekOf: new Date(weekOf) },
      data: { resolvedAt },
      include: { challenge: true },
    });
  },

  async markUnresolved(weekOf) {
    return prisma.weeklyChallenge.update({
      where: { weekOf: new Date(weekOf) },
      data: { resolvedAt: null },
      include: { challenge: true },
    });
  },
};

module.exports = { WeeklyChallenge };
