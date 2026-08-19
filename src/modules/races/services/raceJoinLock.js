const { prisma } = require("../../../db");

// Serialize capacity-sensitive race joins on the race id. The callback receives
// the lock transaction so callers with coupled durable writes can commit them
// before returning deferred post-commit work from the lock.
async function withRaceJoinLock(raceId, callback) {
  return prisma.$transaction(async (tx) => {
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
    return callback(tx);
  });
}

module.exports = { withRaceJoinLock };
