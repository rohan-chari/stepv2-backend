const { prisma } = require("../db");

function buildWriteData(sample, { includePeriodStart = false, includeUserId = false, userId } = {}) {
  const data = {
    steps: sample.steps,
    periodEnd: new Date(sample.periodEnd),
  };

  if (includeUserId) {
    data.userId = userId;
  }

  if (includePeriodStart) {
    data.periodStart = new Date(sample.periodStart);
  }

  if (typeof sample.sourceName === "string") {
    data.sourceName = sample.sourceName;
  }

  if (typeof sample.sourceId === "string") {
    data.sourceId = sample.sourceId;
  }

  if (typeof sample.sourceDeviceId === "string") {
    data.sourceDeviceId = sample.sourceDeviceId;
  }

  if (typeof sample.deviceModel === "string") {
    data.deviceModel = sample.deviceModel;
  }

  if (typeof sample.recordingMethod === "string") {
    data.recordingMethod = sample.recordingMethod;
  }

  if (Object.prototype.hasOwnProperty.call(sample, "metadata")) {
    data.metadata = sample.metadata ?? null;
  }

  return data;
}

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
          update: buildWriteData(s),
          create: buildWriteData(s, { includePeriodStart: true, includeUserId: true, userId }),
        })
      )
    );
  },

  async findByUserIdAndTimeRange(userId, startTime, endTime) {
    return prisma.stepSample.findMany({
      where: {
        userId,
        periodEnd: { gt: new Date(startTime) },
        periodStart: { lt: new Date(endTime) },
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
