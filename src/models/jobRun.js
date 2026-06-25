const { prisma } = require("../db");

// Persisted once-per-ET-day idempotency marker for the ET-anchored cron jobs.
// See utils/etSchedule.js for how `lastRanFor` (a "YYYY-MM-DD" ET day-key) is
// used to gate a daily job to a single run per day across restarts and DST.
const JobRun = {
  // The day-key this job last completed for, or null if it has never run.
  async lastRanFor(jobName) {
    const row = await prisma.jobRun.findUnique({ where: { jobName } });
    return row ? row.lastRanFor : null;
  },

  // Mark `jobName` as having completed its run for `dayKey`. Upsert so the first
  // run inserts and subsequent runs update the single per-job row.
  async markRan(jobName, dayKey) {
    return prisma.jobRun.upsert({
      where: { jobName },
      create: { jobName, lastRanFor: dayKey },
      update: { lastRanFor: dayKey },
    });
  },
};

module.exports = { JobRun };
