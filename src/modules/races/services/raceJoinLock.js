const { withAdvisoryLock } = require("../../../shared/db/withAdvisoryLock");

// Serialize capacity-sensitive race joins on the race id. The callback runs on
// the global client (not the lock's transaction) — the lock provides mutual
// exclusion only, exactly as before the shared-helper extraction.
async function withRaceJoinLock(raceId, callback) {
  return withAdvisoryLock(raceId, () => callback());
}

module.exports = { withRaceJoinLock };
