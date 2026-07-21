const { prisma: defaultPrisma } = require("../../db");

// Shared advisory-lock idiom (audit §4): serialize concurrent work on a string
// id via Postgres pg_advisory_xact_lock(hashtext(id)). The lock is scoped to
// the wrapping transaction — it auto-releases on commit AND on rollback, so a
// throwing `fn` can never leak a held lock. Different ids hash to different
// lock keys and do not block each other.
//
// `fn(tx)` receives the transaction client; callers that want their writes
// covered by the lock's transaction use it (tournament flows), callers that
// only need mutual exclusion may ignore it (race join flows).
//
// NOTE: the transaction (and therefore the lock) stays open for fn's full
// duration — keep fn short. Never use this around a long-running job callback
// (see the cron-dedup outage note in models/jobRun.js).
async function withAdvisoryLock(id, fn, { prisma = defaultPrisma } = {}) {
  return prisma.$transaction(async (tx) => {
    await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtext(${id}))`;
    return fn(tx);
  });
}

module.exports = { withAdvisoryLock };
