const { withAdvisoryLock } = require("../../../shared/db/withAdvisoryLock");

// Serialize capacity-sensitive race joins on the race id. The callback receives
// the lock transaction so callers with coupled durable writes can commit them
// before returning deferred post-commit work from the lock.
async function withRaceJoinLock(raceId, callback) {
  return withAdvisoryLock(raceId, (tx) => callback(tx));
}

module.exports = { withRaceJoinLock };
