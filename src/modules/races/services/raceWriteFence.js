const {
  prisma: defaultPrisma,
  runInPrismaTransaction: defaultRunInPrismaTransaction,
} = require("../../../db");
const {
  RaceResolutionJobV2,
} = require("../models/raceResolutionJobV2");

// C0 is the first lock for every race membership or lifecycle writer. Keeping
// this in one primitive prevents admissions, releases, and settlement from
// taking mutually incompatible lock orders as those paths evolve.
async function acquireRaceWriteFence(tx, raceId) {
  if (!tx || !raceId) throw new TypeError("tx and raceId are required");
  return RaceResolutionJobV2.acquireForWrite(tx, { raceId });
}

async function acquireRaceWriteFences(tx, raceIds) {
  if (!tx || !Array.isArray(raceIds)) {
    throw new TypeError("tx and raceIds are required");
  }
  const ordered = [...new Set(raceIds.filter(Boolean))].sort();
  for (const raceId of ordered) await acquireRaceWriteFence(tx, raceId);
  return ordered;
}

async function acquireFundedMembershipRaceWriteFences(
  tx,
  { userIds = [], targetRaceIds = [] } = {},
) {
  const orderedUsers = [...new Set(userIds.filter(Boolean))].sort();
  const discovered = orderedUsers.length === 0
    ? []
    : await tx.raceParticipant.findMany({
        where: {
          userId: { in: orderedUsers },
          status: "ACCEPTED",
          finishedAt: null,
          forfeitedAt: null,
          race: {
            fundedPrize: true,
            status: { in: ["PENDING", "ACTIVE"] },
          },
        },
        select: { raceId: true },
      });
  return acquireRaceWriteFences(tx, [
    ...targetRaceIds,
    ...discovered.map((row) => row.raceId),
  ]);
}

async function lockCompetitionRows(
  tx,
  { raceIds = [], tournamentIds = [] } = {},
) {
  if (!tx) throw new TypeError("tx is required");
  const competitions = [
    ...new Set(raceIds.filter(Boolean)),
  ].map((id) => ({ kind: "race", id, key: `race:${id}` }));
  competitions.push(
    ...[...new Set(tournamentIds.filter(Boolean))].map((id) => ({
      kind: "tournament",
      id,
      key: `tournament:${id}`,
    })),
  );
  competitions.sort((left, right) => left.key.localeCompare(right.key));
  const locked = [];
  for (const competition of competitions) {
    const table = competition.kind === "race" ? "races" : "tournaments";
    const rows = await tx.$queryRawUnsafe(
      `SELECT id FROM ${table} WHERE id = $1 FOR UPDATE`,
      competition.id,
    );
    if (rows.length > 0) locked.push(competition);
  }
  return locked;
}

async function withRaceWriteFence(
  raceId,
  write,
  {
    prisma = defaultPrisma,
    runInPrismaTransaction = defaultRunInPrismaTransaction,
    timeout = 15_000,
    maxWait = 10_000,
  } = {},
) {
  return runInPrismaTransaction(async (tx) => {
    await acquireRaceWriteFence(tx, raceId);
    return write(tx);
  }, { timeout, maxWait });
}

module.exports = {
  acquireRaceWriteFence,
  acquireRaceWriteFences,
  acquireFundedMembershipRaceWriteFences,
  lockCompetitionRows,
  withRaceWriteFence,
};
