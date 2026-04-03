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

    const samples = await prisma.$queryRawUnsafe(
      `SELECT period_start AS "start", period_end AS "end", steps
       FROM step_samples
       WHERE user_id = $1
         AND period_end > $2::timestamp
         AND period_start < $3::timestamp`,
      userId, start, end
    );

    const windowStartMs = new Date(start).getTime();
    const windowEndMs = new Date(end).getTime();

    let total = 0;
    for (const sample of samples) {
      const sampleStart = sample.start.getTime();
      const sampleEnd = sample.end.getTime();
      const sampleDuration = sampleEnd - sampleStart;

      if (sampleDuration <= 0) continue;

      const overlapStart = Math.max(sampleStart, windowStartMs);
      const overlapEnd = Math.min(sampleEnd, windowEndMs);
      const overlapDuration = overlapEnd - overlapStart;

      if (overlapDuration <= 0) continue;

      if (overlapDuration >= sampleDuration) {
        total += sample.steps;
      } else {
        total += Math.round(sample.steps * (overlapDuration / sampleDuration));
      }
    }

    return total;
  },
};

module.exports = { StepSample };
