const { prisma } = require("../../db");

// Persisted once-per-ET-day idempotency marker for the ET-anchored cron jobs.
// See shared/time/etSchedule.js for how `lastRanFor` (a "YYYY-MM-DD" ET day-key) is
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

  // ATOMIC compare-and-set claim (§7). Unlike markRan (a plain read-then-upsert
  // where two cluster workers can both observe "not ran yet" and both proceed),
  // this claims the (jobName, dayKey) tick for exactly ONE caller across all
  // processes. Returns true iff THIS call won the claim.
  //
  // updateMany flips the row from any other day-key to dayKey atomically: only
  // one worker's UPDATE matches `lastRanFor != dayKey` and gets count 1. A count
  // of 0 means either the row already holds dayKey (already claimed today) or it
  // doesn't exist yet — the create handles first-ever runs, with the unique PK
  // making concurrent creates safe (the loser gets P2002 -> false).
  async claimRun(jobName, dayKey) {
    const res = await prisma.jobRun.updateMany({
      where: { jobName, lastRanFor: { not: dayKey } },
      data: { lastRanFor: dayKey },
    });
    if (res.count === 1) return true;
    if (res.count > 1) return true; // defensive; PK guarantees at most one row
    try {
      await prisma.jobRun.create({ data: { jobName, lastRanFor: dayKey } });
      return true; // first-ever run for this job key
    } catch (error) {
      if (error && error.code === "P2002") return false; // row already at dayKey
      throw error;
    }
  },
};

module.exports = { JobRun };
