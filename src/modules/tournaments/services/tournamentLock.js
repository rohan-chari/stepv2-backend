const { prisma: defaultPrisma } = require("../../../db");
const {
  acquireGlobalEnrollmentLock,
} = require("../../steps/services/globalEventEnrollment");

// Serialize every capacity-sensitive tournament mutation (join / accept / leave
// / kick / invite / cancel / start) on the tournament id, so concurrent joins
// can't both fill the last slot. Same advisory-xact-lock discipline as
// withRaceJoinLock (shared/db/withAdvisoryLock); the lock auto-releases when
// the transaction ends.
//
// `fn(tx, deferred)` runs inside the transaction; push event payloads onto
// `deferred` and they are emitted AFTER the transaction commits (settled state).
// Returns { result, deferred }.
async function withTournamentLock(tournamentId, fn, { prisma = defaultPrisma } = {}) {
  const deferred = [];
  const result = await prisma.$transaction(async (tx) => {
    // One lock order for every path that can create an ACTIVE matchup:
    // global enrollment first, then the tournament mutation lock.
    await acquireGlobalEnrollmentLock(tx);
    await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtext(${tournamentId}))`;
    return fn(tx, deferred);
  });
  return { result, deferred };
}

module.exports = { withTournamentLock };
