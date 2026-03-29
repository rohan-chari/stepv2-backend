const { prisma } = require("../db");

const Steps = {
  async findByUserId(userId) {
    return prisma.step.findMany({
      where: { userId },
      orderBy: { date: "desc" },
    });
  },

  async findByUserIdAndDate(userId, date) {
    return prisma.step.findUnique({
      where: { userId_date: { userId, date: new Date(date) } },
    });
  },

  async create({ userId, steps, date, stepGoal }) {
    return prisma.step.create({
      data: { userId, steps, date: new Date(date), stepGoal },
    });
  },

  async update(id, fields) {
    return prisma.step.update({
      where: { id },
      data: fields,
    });
  },

  async findByUserIdAndDateRange(userId, startDate, endDate) {
    return prisma.step.findMany({
      where: {
        userId,
        date: { gte: new Date(startDate), lte: new Date(endDate) },
      },
      orderBy: { date: "asc" },
    });
  },

  async sumStepsForUsers(userIds, startDate, endDate) {
    if (userIds.length === 0) return new Map();

    const results = await prisma.step.groupBy({
      by: ["userId"],
      _sum: { steps: true },
      where: {
        userId: { in: userIds },
        date: { gte: new Date(startDate), lte: new Date(endDate) },
      },
    });

    const totals = new Map();
    for (const row of results) {
      totals.set(row.userId, row._sum.steps || 0);
    }
    return totals;
  },
};

module.exports = { Steps };
