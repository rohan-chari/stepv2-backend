const { prisma } = require("../db");

async function withRaceJoinLock(raceId, callback) {
  return prisma.$transaction(async (tx) => {
    await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtext(${raceId}))`;
    return callback();
  });
}

module.exports = { withRaceJoinLock };
