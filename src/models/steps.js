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

  async create({ userId, steps, date }) {
    return prisma.step.create({
      data: { userId, steps, date: new Date(date) },
    });
  },

  async update(id, fields) {
    return prisma.step.update({
      where: { id },
      data: fields,
    });
  },
};

module.exports = { Steps };
