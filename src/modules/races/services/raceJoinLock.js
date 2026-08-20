const {
  acquireRaceWriteFence,
  acquireFundedMembershipRaceWriteFences,
  lockCompetitionRows,
} = require("./raceWriteFence");
const {
  runInPrismaTransaction,
} = require("../../../db");
const { lockFundedExposureUsers } = require("./fundedExposure");

// Serialize capacity-sensitive race joins on the race id. The callback receives
// the lock transaction so callers with coupled durable writes can commit them
// before returning deferred post-commit work from the lock.
async function withRaceJoinLock(
  raceId,
  callback,
  { fundedExposureUserIds = [] } = {},
) {
  return runInPrismaTransaction(async (tx) => {
    await acquireFundedMembershipRaceWriteFences(tx, {
      userIds: fundedExposureUserIds,
      targetRaceIds: [raceId],
    });
    // C0 above is always first. Keep the legacy global/advisory locks after it
    // so mixed-version joiners still serialize while the new fence rolls out.
    await tx.$executeRawUnsafe(
      "SELECT pg_advisory_xact_lock(hashtextextended($1, 0))",
      "global-event-enrollment"
    );
    await tx.$executeRawUnsafe(
      // Keep the pre-local-event key exactly stable so mixed-version workers
      // still serialize capacity-sensitive joins against one another.
      "SELECT pg_advisory_xact_lock(hashtext($1))",
      raceId
    );
    await lockFundedExposureUsers(tx, fundedExposureUserIds);
    await lockCompetitionRows(tx, { raceIds: [raceId] });
    return callback(tx);
  }, { timeout: 15_000, maxWait: 10_000 });
}

module.exports = { acquireRaceWriteFence, withRaceJoinLock };
