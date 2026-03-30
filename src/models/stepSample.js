const { prisma } = require("../db");

const StepSample = {
  async upsertBatch(userId, samples) {
    return prisma.$transaction(
      samples.map((s) =>
        prisma.stepSample.upsert({
          where: {
            userId_periodStart: {
              userId,
              periodStart: new Date(s.periodStart),
            },
          },
          update: { steps: s.steps, periodEnd: new Date(s.periodEnd) },
          create: {
            userId,
            periodStart: new Date(s.periodStart),
            periodEnd: new Date(s.periodEnd),
            steps: s.steps,
          },
        })
      )
    );
  },

  async findByUserIdAndTimeRange(userId, startTime, endTime) {
    return prisma.stepSample.findMany({
      where: {
        userId,
        periodStart: { gte: new Date(startTime) },
        periodEnd: { lte: new Date(endTime) },
      },
      orderBy: { periodStart: "asc" },
    });
  },

  async sumStepsInWindow(userId, windowStart, windowEnd) {
    const result = await prisma.stepSample.aggregate({
      _sum: { steps: true },
      where: {
        userId,
        periodStart: { gte: new Date(windowStart) },
        periodEnd: { lte: new Date(windowEnd) },
      },
    });
    return result._sum.steps || 0;
  },
};

module.exports = { StepSample };
