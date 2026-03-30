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
    // All timestamps stored as 'timestamp without time zone' representing UTC.
    // Use raw SQL with plain timestamp comparison -- no ::timestamptz casts.
    const start = typeof windowStart === 'string' ? windowStart : new Date(windowStart).toISOString();
    const end = typeof windowEnd === 'string' ? windowEnd : new Date(windowEnd).toISOString();
    const result = await prisma.$queryRawUnsafe(
      `SELECT COALESCE(SUM(steps), 0)::int AS total
       FROM step_samples
       WHERE user_id = $1
         AND period_end > $2::timestamp
         AND period_start < $3::timestamp`,
      userId, start, end
    );
    return result[0]?.total || 0;
  },
};

module.exports = { StepSample };
