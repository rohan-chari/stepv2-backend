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

  // Same write shape as upsertBatch, but run against a caller-provided
  // transaction client (Prisma tx or the base client) so sync-v2's Transaction A
  // can upsert steps, samples, and the idempotency reservation atomically. Runs
  // the upserts sequentially on the given client (interactive-tx safe).
  async upsertBatchOn(client, userId, samples) {
    const results = [];
    for (const s of samples) {
      results.push(
        await client.stepSample.upsert({
          where: {
            userId_periodStart: { userId, periodStart: new Date(s.periodStart) },
          },
          update: buildWriteData(s),
          create: buildWriteData(s, { includePeriodStart: true, includeUserId: true, userId }),
        })
      );
    }
    return results;
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
    const sums = await this.sumStepsInWindows(userId, [
      { start: windowStart, end: windowEnd },
    ]);
    return sums[0];
  },

  // Bulk fetch for cross-participant batching (see getHomeRaceCard): all of
  // several users' samples overlapping [rangeStart, rangeEnd), with the same
  // overlap predicate sumStepsInWindows uses, so prorating these rows against
  // any window inside the range gives identical results to a per-user query.
  async findRowsForUsersInRange(userIds, rangeStart, rangeEnd) {
    if (!userIds || userIds.length === 0) return [];
    const start =
      typeof rangeStart === "string" ? rangeStart : new Date(rangeStart).toISOString();
    const end =
      typeof rangeEnd === "string" ? rangeEnd : new Date(rangeEnd).toISOString();

    return prisma.$queryRawUnsafe(
      `SELECT user_id AS "userId", period_start AS "start", period_end AS "end", steps
       FROM step_samples
       WHERE user_id = ANY($1::text[])
         AND period_end > $2::timestamp
         AND period_start < $3::timestamp`,
      userIds, start, end
    );
  },

  // Batched variant of sumStepsInWindow: ONE fetch spanning all windows, then
  // the same per-window proration. Returns an array of sums parallel to
  // `windows` ({start, end} each). Exists so per-day loops (see
  // calculateSubsequentSteps) cost one query instead of one per day; results
  // are identical to calling sumStepsInWindow per window because the overlap
  // check discards any fetched sample that falls between windows.
  async sumStepsInWindows(userId, windows) {
    if (!windows || windows.length === 0) return [];

    // All timestamps stored as 'timestamp without time zone' representing UTC.
    // Use raw SQL with plain timestamp comparison -- no ::timestamptz casts.
    const parsed = windows.map((w) => ({
      start: typeof w.start === "string" ? w.start : new Date(w.start).toISOString(),
      end: typeof w.end === "string" ? w.end : new Date(w.end).toISOString(),
    }));

    const fetchStart = parsed
      .map((w) => w.start)
      .reduce((a, b) => (new Date(a) <= new Date(b) ? a : b));
    const fetchEnd = parsed
      .map((w) => w.end)
      .reduce((a, b) => (new Date(a) >= new Date(b) ? a : b));

    const samples = await prisma.$queryRawUnsafe(
      `SELECT period_start AS "start", period_end AS "end", steps
       FROM step_samples
       WHERE user_id = $1
         AND period_end > $2::timestamp
         AND period_start < $3::timestamp`,
      userId, fetchStart, fetchEnd
    );

    return parsed.map((w) =>
      prorateSamplesIntoWindow(
        samples,
        new Date(w.start).getTime(),
        new Date(w.end).getTime()
      )
    );
  },
};

// A sample overlapping the window contributes its steps, prorated linearly by
// the overlapped fraction of its duration. Shared by the single- and batched-
// window sums so the two can never diverge.
function prorateSamplesIntoWindow(samples, windowStartMs, windowEndMs) {
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
}

module.exports = { StepSample, prorateSamplesIntoWindow };
