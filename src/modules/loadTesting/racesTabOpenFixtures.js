const crypto = require("node:crypto");
const { assertFixtureDatabase } = require("./fixtures");
const {
  cleanupHomeOpenFixtures,
  createHomeOpenFixtures,
} = require("./homeOpenFixtures");

function normalizeFriendDistribution(row = {}) {
  const sampleUsers = Number(row.userCount);
  const zeroFriendsUsers = Number(row.zeroFriendsCount);
  if (!Number.isInteger(sampleUsers) || sampleUsers < 1 ||
      !Number.isInteger(zeroFriendsUsers) || zeroFriendsUsers < 0 ||
      zeroFriendsUsers > sampleUsers) {
    throw new Error("invalid production friends distribution");
  }
  const sourceTimestamp = new Date(row.sourceTimestamp);
  if (Number.isNaN(sourceTimestamp.getTime())) {
    throw new Error("invalid production friends distribution timestamp");
  }
  return {
    schema: "races-tab-friends-distribution-v1",
    sourceTimestamp: sourceTimestamp.toISOString(),
    sampleUsers,
    zeroFriendsUsers,
    zeroFriendsShare: zeroFriendsUsers / sampleUsers,
  };
}

function interleaveZeroFriends({ users, zeroFriends }) {
  if (!Number.isInteger(users) || users < 1 || !Number.isInteger(zeroFriends) ||
      zeroFriends < 0 || zeroFriends > users) {
    throw new Error("invalid zero-friends cohort");
  }
  return Array.from({ length: users }, (_, index) =>
    Math.floor((index + 1) * zeroFriends / users) > Math.floor(index * zeroFriends / users));
}

async function readFriendDistribution(prisma) {
  const rows = await prisma.$queryRawUnsafe(`WITH accepted AS (
      SELECT requester_id AS user_id FROM friendships WHERE status = 'ACCEPTED'
      UNION
      SELECT addressee_id AS user_id FROM friendships WHERE status = 'ACCEPTED'
    )
    SELECT count(*)::int AS "userCount",
           count(*) FILTER (WHERE accepted.user_id IS NULL)::int AS "zeroFriendsCount",
           greatest(max(users.created_at),
             COALESCE((SELECT max(updated_at) FROM friendships), max(users.created_at)))
             AS "sourceTimestamp"
      FROM users LEFT JOIN accepted ON accepted.user_id = users.id`);
  return normalizeFriendDistribution(rows[0]);
}

function nonZeroFriendCount(users, share) {
  let zeroFriends = Math.max(0, Math.min(users, Math.round(users * share)));
  if (users > 1 && users - zeroFriends === 1) zeroFriends -= 1;
  return zeroFriends;
}

function friendshipRows(users, zeroFlags) {
  const connected = users.filter((_, index) => !zeroFlags[index]);
  if (connected.length < 2) return [];
  const pairs = [];
  for (let index = 0; index + 1 < connected.length; index += 2) {
    pairs.push([connected[index], connected[index + 1]]);
  }
  if (connected.length % 2 === 1) pairs.push([connected.at(-1), connected[0]]);
  return pairs.map(([requester, addressee]) => ({
    id: crypto.randomUUID(), requesterId: requester.id, addresseeId: addressee.id,
    status: "ACCEPTED",
  }));
}

function stableDate(value) {
  return value == null ? null : new Date(value).toISOString();
}

function fixtureStateEvidence(rows = {}) {
  const users = (rows.users || []).map((row) => ({ id: row.id }))
    .sort((left, right) => left.id.localeCompare(right.id));
  const races = (rows.races || []).map((row) => ({ id: row.id, status: row.status,
    startedAt: stableDate(row.startedAt), endsAt: stableDate(row.endsAt) }))
    .sort((left, right) => left.id.localeCompare(right.id));
  const participants = (rows.participants || []).map((row) => ({ id: row.id,
    raceId: row.raceId, userId: row.userId, status: row.status }))
    .sort((left, right) => left.id.localeCompare(right.id));
  const friendships = (rows.friendships || []).map((row) => ({ id: row.id,
    requesterId: row.requesterId, addresseeId: row.addresseeId, status: row.status }))
    .sort((left, right) => left.id.localeCompare(right.id));
  const byStatus = (values) => values.reduce((result, row) => {
    result[row.status] = (result[row.status] || 0) + 1; return result;
  }, {});
  const stableFingerprint = crypto.createHash("sha256")
    .update(JSON.stringify({ users, races, participants, friendships })).digest("hex");
  return {
    schema: "races-tab-fixture-state-evidence-v1",
    stableFingerprint,
    census: {
      users: users.length,
      races: races.length,
      racesByStatus: byStatus(races),
      participants: participants.length,
      participantsByStatus: byStatus(participants),
      friendships: friendships.length,
      friendshipsByStatus: byStatus(friendships),
    },
  };
}

async function captureFixtureState(prisma, ids = {}) {
  const users = Array.isArray(ids.users) ? ids.users : [];
  const races = Array.isArray(ids.races) ? ids.races : [];
  const participants = Array.isArray(ids.raceParticipants) ? ids.raceParticipants : [];
  const friendships = Array.isArray(ids.friendships) ? ids.friendships : [];
  const [userRows, raceRows, participantRows, friendshipStateRows] = await Promise.all([
    users.length ? prisma.user.findMany({ where: { id: { in: users } },
      select: { id: true } }) : [],
    races.length ? prisma.race.findMany({ where: { id: { in: races } },
      select: { id: true, status: true, startedAt: true, endsAt: true } }) : [],
    participants.length ? prisma.raceParticipant.findMany({ where: { id: { in: participants } },
      select: { id: true, raceId: true, userId: true, status: true } }) : [],
    friendships.length ? prisma.friendship.findMany({ where: { id: { in: friendships } },
      select: { id: true, requesterId: true, addresseeId: true, status: true } }) : [],
  ]);
  return fixtureStateEvidence({ users: userRows, races: raceRows,
    participants: participantRows, friendships: friendshipStateRows });
}

async function createRacesTabOpenFixtures({
  prisma, runId, users = 5000, arrivalRate = 1, scoreShape = "production",
  env = process.env, now = new Date(), createBaseFixtures = createHomeOpenFixtures,
} = {}) {
  assertFixtureDatabase(env);
  const distribution = await readFriendDistribution(prisma);
  const base = await createBaseFixtures({ prisma, runId, users, arrivalRate,
    scoreShape, env, now });
  try {
    const zeroFriends = nonZeroFriendCount(base.users.length, distribution.zeroFriendsShare);
    const flags = interleaveZeroFriends({ users: base.users.length, zeroFriends });
    const rows = friendshipRows(base.users, flags);
    if (rows.length) await prisma.friendship.createMany({ data: rows });
    base.manifest.ids.friendships = rows.map((row) => row.id);
    const preScanState = await captureFixtureState(prisma, base.manifest.ids);
    base.manifest.racesTabState = preScanState;
    const sourceHash = crypto.createHash("sha256")
      .update(JSON.stringify(distribution)).digest("hex");
    const cleanupFriendships = () => rows.length
      ? prisma.friendship.deleteMany({ where: { id: { in: rows.map((row) => row.id) } } })
      : Promise.resolve({ count: 0 });
    return {
      ...base,
      users: base.users.map((user, index) => ({ ...user, zeroFriends: flags[index] })),
      topology: {
        ...base.topology,
        schema: "races-tab-open-fixture-topology-v1",
        cohortOrdering: "balanced-marginals-active-races-zero-friends-v1",
        friendDistribution: distribution,
        friendDistributionSourceHash: sourceHash,
        zeroFriendsCount: zeroFriends,
        zeroFriendsShare: base.users.length ? zeroFriends / base.users.length : 0,
        friendshipsMaterialized: rows.length,
        modeledStateProfile: {
          schema: "races-tab-modeled-state-profile-v1",
          included: ["active-race-count", "zero-race", "zero-friends"],
          deferred: ["pending", "completed", "invited", "tournament", "team-race",
            "review-opportunity", "payout-double"],
        },
        preScanState,
      },
      cleanupFriendships,
    };
  } catch (error) {
    await cleanupHomeOpenFixtures({ prisma, manifest: base.manifest }).catch(() => {});
    throw error;
  }
}

async function cleanupRacesTabOpenFixtures({ prisma, manifest } = {}) {
  const ids = Array.isArray(manifest?.ids?.friendships) ? manifest.ids.friendships : [];
  if (ids.length) await prisma.friendship.deleteMany({ where: { id: { in: ids } } });
  return cleanupHomeOpenFixtures({ prisma, manifest });
}

async function verifyRacesTabOpenFixtures({ prisma, manifest } = {}) {
  const before = manifest?.racesTabState;
  if (before?.schema !== "races-tab-fixture-state-evidence-v1") {
    throw new Error("races-tab fixture baseline evidence is missing");
  }
  const after = await captureFixtureState(prisma, manifest?.ids);
  const stable = before.stableFingerprint === after.stableFingerprint;
  if (!stable) throw new Error("races-tab fixture distribution drifted during the scan");
  return { schema: "races-tab-fixture-stability-v1", stable, before, after };
}

module.exports = {
  cleanupRacesTabOpenFixtures,
  createRacesTabOpenFixtures,
  fixtureStateEvidence,
  interleaveZeroFriends,
  normalizeFriendDistribution,
  readFriendDistribution,
  verifyRacesTabOpenFixtures,
};
