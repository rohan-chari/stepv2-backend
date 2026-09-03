const assert = require("node:assert/strict");
const test = require("node:test");

const {
  createRacesTabOpenFixtures,
  fixtureStateEvidence,
  interleaveZeroFriends,
  normalizeFriendDistribution,
  verifyRacesTabOpenFixtures,
} = require("../../../src/modules/loadTesting/racesTabOpenFixtures");

test("zero-friends cohort is deterministic and representative in early prefixes", () => {
  const first = interleaveZeroFriends({ users: 20, zeroFriends: 7 });
  const second = interleaveZeroFriends({ users: 20, zeroFriends: 7 });
  assert.deepEqual(first, second);
  assert.equal(first.filter(Boolean).length, 7);
  for (const size of [5, 10, 15, 20]) {
    const observed = first.slice(0, size).filter(Boolean).length / size;
    assert.ok(Math.abs(observed - 7 / 20) <= 1 / size);
  }
});

test("production aggregate normalizes to an identifier-free versioned distribution", () => {
  assert.deepEqual(normalizeFriendDistribution({ userCount: "100", zeroFriendsCount: "37",
    sourceTimestamp: new Date("2026-09-03T10:00:00Z") }), {
    schema: "races-tab-friends-distribution-v1",
    sourceTimestamp: "2026-09-03T10:00:00.000Z",
    sampleUsers: 100,
    zeroFriendsUsers: 37,
    zeroFriendsShare: 0.37,
  });
  assert.throws(() => normalizeFriendDistribution({ userCount: 1, zeroFriendsCount: 2 }),
    /distribution/i);
});

test("fixture materializes the measured branch share and authenticated identities", async () => {
  const friendships = [];
  const deleted = [];
  const base = {
    manifest: { runId: "races-fixture", ids: { users: ["u0", "u1", "u2", "u3"] } },
    users: [0, 1, 2, 3].map((index) => ({ id: `u${index}`, token: `token-${index}` })),
    races: [], topology: { schema: "home-open-fixture-topology-v1" },
  };
  const prisma = {
    $queryRawUnsafe: async () => [{ userCount: "4", zeroFriendsCount: "2",
      sourceTimestamp: new Date("2026-09-03T10:00:00Z") }],
    friendship: {
      createMany: async ({ data }) => { friendships.push(...data); return { count: data.length }; },
      deleteMany: async ({ where }) => { deleted.push(where); return { count: friendships.length }; },
      findMany: async () => friendships,
    },
    user: { findMany: async () => base.users.map(({ id }) => ({ id })) },
    race: { findMany: async () => [] },
    raceParticipant: { findMany: async () => [] },
  };
  const fixture = await createRacesTabOpenFixtures({ prisma, runId: "races-fixture", users: 4,
    env: { DATABASE_URL: "postgresql://localhost/races_capacity_test" },
    createBaseFixtures: async () => base,
  });
  assert.equal(fixture.users.filter((user) => user.zeroFriends).length, 2);
  assert.ok(fixture.users.every((user) => user.token.startsWith("token-")));
  assert.equal(friendships.length, 1);
  assert.equal(fixture.topology.zeroFriendsShare, 0.5);
  assert.match(fixture.topology.friendDistributionSourceHash, /^[a-f0-9]{64}$/);
  assert.deepEqual(fixture.topology.modeledStateProfile, {
    schema: "races-tab-modeled-state-profile-v1",
    included: ["active-race-count", "zero-race", "zero-friends"],
    deferred: ["pending", "completed", "invited", "tournament", "team-race",
      "review-opportunity", "payout-double"],
  });
  assert.equal(fixture.topology.preScanState.stableFingerprint.length, 64);
  assert.deepEqual(fixture.manifest.ids.friendships, friendships.map((row) => row.id));
  await fixture.cleanupFriendships();
  assert.equal(deleted.length, 1);
});

test("one post-scan verification detects status drift even when row counts do not change", async () => {
  const manifest = { ids: { users: ["u1", "u2"], races: ["r1"],
    raceParticipants: ["p1", "p2"], friendships: ["f1"] } };
  let raceStatus = "ACTIVE";
  const currentRows = () => ({
    users: [{ id: "u1" }, { id: "u2" }],
    races: [{ id: "r1", status: raceStatus, startedAt: new Date("2026-09-03T00:00:00Z"),
      endsAt: new Date("2026-09-04T00:00:00Z") }],
    participants: [{ id: "p1", raceId: "r1", userId: "u1", status: "ACCEPTED" },
      { id: "p2", raceId: "r1", userId: "u2", status: "ACCEPTED" }],
    friendships: [{ id: "f1", requesterId: "u1", addresseeId: "u2", status: "ACCEPTED" }],
  });
  manifest.racesTabState = fixtureStateEvidence(currentRows());
  const prisma = {
    user: { findMany: async () => currentRows().users },
    race: { findMany: async () => currentRows().races },
    raceParticipant: { findMany: async () => currentRows().participants },
    friendship: { findMany: async () => currentRows().friendships },
  };
  assert.equal((await verifyRacesTabOpenFixtures({ prisma, manifest })).stable, true);
  raceStatus = "COMPLETED";
  await assert.rejects(verifyRacesTabOpenFixtures({ prisma, manifest }), /drift/i);
});
