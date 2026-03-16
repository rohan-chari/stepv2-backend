const { prisma } = require("../db");

const Challenge = {
  async findById(id) {
    return prisma.challenge.findUnique({ where: { id } });
  },

  async findActive() {
    return prisma.challenge.findMany({ where: { active: true } });
  },

  async markUsed(id) {
    return prisma.challenge.update({
      where: { id },
      data: { lastUsedAt: new Date() },
    });
  },

  async findCurrentWeek() {
    // The most recently used challenge that was used this week (since last Monday)
    const now = new Date();
    const monday = new Date(now);
    monday.setDate(monday.getDate() - ((monday.getDay() + 6) % 7));
    monday.setHours(0, 0, 0, 0);

    return prisma.challenge.findFirst({
      where: {
        active: true,
        lastUsedAt: { gte: monday },
      },
      orderBy: { lastUsedAt: "desc" },
    });
  },
};

module.exports = { Challenge };
