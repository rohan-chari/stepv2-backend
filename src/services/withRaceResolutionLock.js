const { prisma } = require("../db");

// Transaction-scoped Postgres advisory lock derived from a race UUID, used to
// serialize the four reconciliation paths that read-modify-write the SAME race:
// uploader-scoped reconciliation (sync-v2), the async full-field worker, legacy
// synchronous full reconciliation, and placement recompute. Holding the lock
// while one path recomputes a race prevents two paths from interleaving reads and
// writes on the same participants (e.g. simultaneous mine/overtake evaluation).
//
// The lock is xact-scoped: it is held for the lifetime of the wrapping
// transaction, which awaits `callback`, so the callback runs with the lock held
// and it releases on commit. Mirrors withRaceJoinLock / tournamentLock. Callers
// that touch several races MUST process race ids in a stable sorted order to
// avoid deadlocks (see reconcileUploaderRaces / the worker).
// The wrapping interactive transaction stays open for the whole callback (that
// is how an xact-scoped lock is held), so it gets generous timeouts: a full-field
// race reconciliation (all participants + trail mines) can take longer than
// Prisma's 5s interactive-transaction default under load. maxWait covers pool
// contention while acquiring the lock connection.
const TX_OPTIONS = { maxWait: 15000, timeout: 30000 };

async function withRaceResolutionLock(raceId, callback) {
  return prisma.$transaction(async (tx) => {
    await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtext(${raceId})::bigint)`;
    return callback();
  }, TX_OPTIONS);
}

module.exports = { withRaceResolutionLock };
