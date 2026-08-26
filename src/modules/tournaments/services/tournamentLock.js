const { prisma: defaultPrisma } = require("../../../db");
const {
  acquireGlobalEnrollmentLock,
} = require("../../steps/services/globalEventEnrollment");
const {
  lockFundedExposureUsers,
} = require("../../races/services/fundedExposure");
const {
  lockCompetitionRows,
} = require("../../races/services/raceWriteFence");
const {
  buildAppendTournamentDomainEvent,
} = require("./appendTournamentDomainEvent");
const appendTournamentDomainEvent = buildAppendTournamentDomainEvent();

// Serialize every capacity-sensitive tournament mutation (join / accept / leave
// / kick / invite / cancel / start) on the tournament id, so concurrent joins
// can't both fill the last slot. Same advisory-xact-lock discipline as
// withRaceJoinLock (shared/db/withAdvisoryLock); the lock auto-releases when
// the transaction ends.
//
// `fn(tx, deferred)` runs inside the transaction; push event payloads onto
// `deferred` and they are emitted AFTER the transaction commits (settled state).
// Returns { result, deferred }.
async function withTournamentLock(
  tournamentId,
  fn,
  {
    prisma = defaultPrisma,
    userIds = [],
    resolveUserIds = null,
  } = {},
) {
  const deferred = [];
  const result = await prisma.$transaction(async (tx) => {
    // One lock order for every path that can create an ACTIVE matchup:
    // global enrollment first, then the tournament mutation lock.
    await acquireGlobalEnrollmentLock(tx);
    await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtext(${tournamentId}))`;
    const resolvedUserIds = resolveUserIds
      ? await resolveUserIds(tx)
      : userIds;
    await lockFundedExposureUsers(tx, resolvedUserIds || []);
    await lockCompetitionRows(tx, { tournamentIds: [tournamentId] });
    const lockedTournament = await tx.tournament.findUnique({
      where: { id: tournamentId },
    });
    const value = await fn(tx, deferred, lockedTournament);
    if (tx.domainEventOutbox) {
      for (const payload of deferred) {
        await appendTournamentDomainEvent(tx, payload);
      }
    }
    return value;
  });
  return { result, deferred };
}

module.exports = { withTournamentLock };
