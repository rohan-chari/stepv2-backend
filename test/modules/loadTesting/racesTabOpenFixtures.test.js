const assert = require("node:assert/strict");
const test = require("node:test");

const {
  buildCoverageAssignments,
  createRacesTabOpenFixtures,
  fixtureStateEvidence,
  interleaveZeroFriends,
  normalizeFriendDistribution,
  materializationPlan,
  materializeFullPageFixtureGraph,
  pinRacesTabSettings,
  restoreRacesTabSettings,
  verifyRacesTabOpenFixtures,
} = require("../../../src/modules/loadTesting/racesTabOpenFixtures");
const { REQUIRED_COVERAGE_VARIANTS } = require(
  "../../../src/modules/loadTesting/racesTabOpenProjection");

test("every ordered 300-session window covers all variants within ten percent augmentation", () => {
  const assignments = buildCoverageAssignments({ users: 5000, prefixSize: 300,
    requiredVariants: REQUIRED_COVERAGE_VARIANTS });
  assert.ok(assignments.augmentationShare <= 0.1);
  assert.equal(assignments.augmentedIdentities, 476);
  for (const offset of [0, 1, 27, 28, 163, 299, 300, 2473, 4700]) {
    const observed = new Set(Array.from({ length: 300 }, (_, index) =>
      assignments.byUser[(offset + index) % assignments.byUser.length]).flat());
    assert.deepEqual([...observed].sort(), [...REQUIRED_COVERAGE_VARIANTS].sort());
  }
  assert.throws(() => buildCoverageAssignments({ users: 299 }), /300/);
});

test("production census incidence is scaled before explicit coverage augmentation", () => {
  const assignments = buildCoverageAssignments({ users: 300, sourceCensus: { counts: {
    userCount: 1000, ordinaryClassicActive: 500,
  } } });
  assert.equal(assignments.naturalCounts.ordinary_classic_active, 150);
  assert.ok(assignments.byUser.filter((rows) => rows.includes("ordinary_classic_active")).length >= 150);
});

test("the full-page plan materializes every API-backed variant and no cancelled tournament", () => {
  const users = Array.from({ length: 300 }, (_, index) => ({ id: `u${index}` }));
  const coverage = buildCoverageAssignments({ users: 300 });
  const plan = materializationPlan({ base: { users }, coverage,
    now: new Date("2026-09-03T00:00:00Z"), runId: "races-plan" });
  assert.equal(plan.races.length > 0, true);
  assert.equal(plan.tournaments.length > 0, true);
  assert.equal(plan.tournaments.some((row) => row.status === "CANCELLED"), false);
  assert.equal(plan.tournamentParticipants.length > 0, true);
  assert.equal(plan.powerups.length > 0, true);
  assert.equal(plan.activeEffects.length > 0, true);
  assert.ok(plan.shopItems.length > 0);
  assert.equal(plan.equippedAccessories.length, plan.userShopItems.length);
  assert.ok(plan.races.every((row) => new Date(row.endsAt || "2099-01-01") >
    new Date("2026-09-03T00:00:00Z")) || plan.races.some((row) => row.status === "COMPLETED"));
});

test("correlated labels share one logical graph", () => {
  const users = Array.from({ length: 4 }, (_, index) => ({ id: `u${index}` }));
  const coverage = { byUser: [["ordinary_classic_active", "pinned_classic",
    "ordinary_inventory_held_typed", "ordinary_effect_positive"], [], [], []] };
  const plan = materializationPlan({ base: { users }, coverage,
    now: new Date("2026-09-03T00:00:00Z"), runId: "correlated" });
  assert.equal(plan.races.length, 1);
  assert.equal(plan.participants.length, 2);
  assert.equal(plan.powerups.length, 2);
  assert.equal(plan.activeEffects.length, 1);
});

test("graph-first scaling shares production-sized graphs across measured identities", () => {
  const users = Array.from({ length: 6 }, (_, index) => ({ id: `u${index}` }));
  const coverage = { byUser: users.map(() => ["ordinary_classic_active"]) };
  const plan = materializationPlan({ base: { users }, coverage,
    sourceCensus: { graphHistograms: { ordinaryParticipantsPerRace: { 3: 1 } } },
    now: new Date("2026-09-03T00:00:00Z"), runId: "shared" });
  assert.equal(plan.races.length, 2);
  assert.deepEqual(plan.races.map((race) => plan.participants
    .filter((participant) => participant.raceId === race.id).length), [3, 3]);
});

test("graph materialization samples production graph histograms deterministically", () => {
  const users = Array.from({ length: 300 }, (_, index) => ({ id: `u${index}` }));
  const coverage = buildCoverageAssignments({ users: 300 });
  const sourceCensus = { graphHistograms: { ordinaryParticipantsPerRace: { 3: 2, 5: 1 },
    tournamentBracketSize: { 8: 1 }, tournamentParticipants: { 4: 1 },
    inventoryPerRace: { 0: 1, 2: 1 }, effectsPerRace: { 0: 1, 1: 1 } } };
  const plan = materializationPlan({ base: { users }, coverage, sourceCensus,
    now: new Date("2026-09-03T00:00:00Z"), runId: "graph-hist" });
  assert.deepEqual(plan.graphEvidence.reconciliation.ordinaryParticipantsPerRace.sourceValues,
    [3, 5]);
  assert.equal(plan.graphEvidence.reconciliation.ordinaryParticipantsPerRace
    .generatedWithinSourceSupport, true);
  assert.equal(plan.graphEvidence.reconciliation.tournamentBracketSize
    .generatedWithinSourceSupport, true);
  assert.ok(plan.graphEvidence.graphRows.some((row) => row.family === "ordinary" &&
    row.participantCount > 2));
});

test("joint graph census keeps participant, inventory, and effect cardinalities correlated", () => {
  const users = Array.from({ length: 8 }, (_, index) => ({ id: `u${index}` }));
  const coverage = { byUser: users.map(() => ["ordinary_classic_active"]) };
  const sourceCensus = { graphJointHistogram: { ordinary: [{ graphs: 1, dimensions: {
    status: "active", team: false, participants: 4, inventory: 2, effects: 1,
  } }], tournaments: [] }, graphHistograms: {} };
  const plan = materializationPlan({ base: { users }, coverage, sourceCensus,
    now: new Date("2026-09-03T00:00:00Z"), runId: "joint-shape" });
  assert.equal(plan.races.length, 2);
  assert.ok(plan.graphEvidence.graphRows.every((row) => row.participantCount === 4 &&
    row.inventoryCount === 2 && row.effectCount === 1));
});

test("joint graph scaling preserves team size and tournament total versus accepted cardinality", () => {
  const users = Array.from({ length: 8 }, (_, index) => ({ id: `u${index}` }));
  const ordinaryCoverage = { byUser: users.map(() => ["ordinary_team_active"]) };
  const ordinary = materializationPlan({ base: { users }, coverage: ordinaryCoverage,
    sourceCensus: { graphJointHistogram: { ordinary: [{ graphs: 1, dimensions: {
      status: "active", team: true, teamSize: 3, participants: 6, inventory: 0, effects: 0,
    } }], tournaments: [] } }, now: new Date("2026-09-03T00:00:00Z"), runId: "teams" });
  assert.ok(ordinary.races.every((race) => race.teamSize === 3 && race.maxParticipants === 6));

  const tournamentCoverage = { byUser: users.map(() => ["tournament_invite"]) };
  const tournaments = materializationPlan({ base: { users }, coverage: tournamentCoverage,
    sourceCensus: { graphJointHistogram: { ordinary: [], tournaments: [{ graphs: 1,
      dimensions: { status: "pending", bracketSize: 4, participants: 5, accepted: 2 } }] } },
    now: new Date("2026-09-03T00:00:00Z"), runId: "tournament-cardinality" });
  for (const tournament of tournaments.tournaments) {
    const rows = tournaments.tournamentParticipants.filter((row) =>
      row.tournamentId === tournament.id);
    assert.equal(rows.length, 5);
    assert.equal(rows.filter((row) => row.status === "ACCEPTED").length, 2);
    assert.equal(tournament.bracketSize, 4);
  }
});

test("graph materialization rejects malformed source census rows instead of silently falling back", () => {
  const users = Array.from({ length: 2 }, (_, index) => ({ id: `u${index}` }));
  const coverage = { byUser: users.map(() => ["ordinary_classic_active"]) };
  assert.throws(() => materializationPlan({ base: { users }, coverage,
    sourceCensus: { graphJointHistogram: { ordinary: [{ graphs: 0,
      dimensions: { status: "active", participants: 2 } }], tournaments: [] } },
    now: new Date("2026-09-03T00:00:00Z"), runId: "bad-census" }),
  /invalid Races-tab source graph joint histogram/i);
});

test("joint per-user census preserves repeated personal-bucket rows before coverage augmentation", () => {
  const users = Array.from({ length: 6 }, (_, index) => ({ id: `u${index}` }));
  const sourceCensus = { counts: { userCount: 6 }, jointHistogram: [{ users: 6,
    dimensions: { active: 2, pending: 1, completed: 0, invited: 0, team: false,
      pinned: false, tournamentInvited: 0, tournamentPending: 0,
      tournamentActive: 0, tournamentCompleted: 0, tournamentPinned: false } }],
  graphJointHistogram: { ordinary: [{ graphs: 1, dimensions: { status: "active",
    team: false, participants: 3, inventory: 0, effects: 0 } }], tournaments: [] } };
  const coverage = buildCoverageAssignments({ users: 6, prefixSize: 2,
    requiredVariants: ["ordinary_classic_active", "ordinary_pending_accepted"],
    maximumAugmentationShare: 1, sourceCensus });
  const plan = materializationPlan({ base: { users }, coverage, sourceCensus,
    now: new Date("2026-09-03T00:00:00Z"), runId: "personal-rows" });
  for (const user of users) {
    assert.equal(plan.participants.filter((row) => row.userId === user.id &&
      plan.races.some((race) => race.id === row.raceId && race.status === "ACTIVE")).length, 2);
    assert.equal(plan.participants.filter((row) => row.userId === user.id &&
      plan.races.some((race) => race.id === row.raceId && race.status === "PENDING")).length, 1);
  }
});

test("joint per-user census preserves mixed classic and team active rows", () => {
  const users = Array.from({ length: 4 }, (_, index) => ({ id: `u${index}` }));
  const sourceCensus = { counts: { userCount: 4 }, jointHistogram: [{ users: 4,
    dimensions: { classicActive: 1, teamActive: 1, pendingOwner: 0, pendingAccepted: 0,
      completed: 0, invited: 0, pinnedClassic: false, pinnedTeam: false,
      tournamentInvited: 0, tournamentPending: 0, tournamentActive: 0,
      tournamentCompleted: 0, tournamentPinned: false } }], graphJointHistogram: {
    ordinary: [{ graphs: 1, dimensions: { status: "active", team: false,
      participants: 2, inventory: 0, effects: 0 } }, { graphs: 1,
      dimensions: { status: "active", team: true, teamSize: 1,
        participants: 2, inventory: 0, effects: 0 } }], tournaments: [] } };
  const coverage = buildCoverageAssignments({ users: 4, prefixSize: 2,
    requiredVariants: ["ordinary_classic_active", "ordinary_team_active"],
    maximumAugmentationShare: 1, sourceCensus });
  const plan = materializationPlan({ base: { users }, coverage, sourceCensus,
    now: new Date("2026-09-03T00:00:00Z"), runId: "mixed-active" });
  for (const user of users) {
    const memberships = plan.participants.filter((row) => row.userId === user.id);
    assert.equal(memberships.filter((row) => !plan.races.find((race) => race.id === row.raceId)
      .isTeamRace).length, 1);
    assert.equal(memberships.filter((row) => plan.races.find((race) => race.id === row.raceId)
      .isTeamRace).length, 1);
  }
});

test("partial graph failure registers every exact cleanup ID before the first write", async () => {
  const users = Array.from({ length: 300 }, (_, index) => ({ id: `u${index}` }));
  const coverage = buildCoverageAssignments({ users: 300 });
  const manifest = { ids: {} };
  const prisma = {
    shopItem: { createMany: async () => ({ count: 1 }) },
    userShopItem: { createMany: async () => ({ count: 1 }) },
    userEquippedAccessory: { createMany: async () => ({ count: 1 }) },
    tournament: { createMany: async () => { throw new Error("injected preparation failure"); } },
    tournamentParticipant: { createMany: async () => ({ count: 0 }) },
    race: { createMany: async () => ({ count: 0 }) },
    raceParticipant: { createMany: async () => ({ count: 0 }) },
    racePowerup: { createMany: async () => ({ count: 0 }) },
    raceActiveEffect: { createMany: async () => ({ count: 0 }) },
  };
  await assert.rejects(materializeFullPageFixtureGraph({ prisma, runId: "partial",
    base: { users, manifest }, manifest, coverage, now: new Date("2026-09-03T00:00:00Z") }),
  /injected/);
  assert.ok(manifest.ids.tournaments.length > 0);
  assert.ok(manifest.ids.races.length > 0);
  assert.ok(manifest.ids.raceParticipants.length > 0);
});

test("every materialization phase leaves the complete owned-ID manifest available to cleanup", async () => {
  const users = Array.from({ length: 300 }, (_, index) => ({ id: `u${index}` }));
  const coverage = buildCoverageAssignments({ users: 300 });
  const phases = ["shopItem", "userShopItem", "userEquippedAccessory", "tournament",
    "tournamentParticipant", "race", "raceParticipant", "racePowerup", "raceActiveEffect"];
  for (const failingPhase of phases) {
    const manifest = { ids: {} };
    const prisma = Object.fromEntries(phases.map((phase) => [phase, { createMany: async () => {
      if (phase === failingPhase) throw new Error(`injected ${phase}`);
      return { count: 1 };
    } }]));
    await assert.rejects(materializeFullPageFixtureGraph({ prisma, runId: `partial-${failingPhase}`,
      base: { users, manifest }, manifest, coverage,
      now: new Date("2026-09-03T00:00:00Z") }), new RegExp(`injected ${failingPhase}`));
    for (const key of ["races", "raceParticipants", "tournaments", "tournamentParticipants",
      "racePowerups", "raceActiveEffects", "shopItems", "userShopItems",
      "userEquippedAccessories"]) assert.ok(Array.isArray(manifest.ids[key]), key);
  }
});

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

test("fixture settings are pinned atomically and exact absent values are restored", async () => {
  const writes = [];
  const deleted = [];
  const settings = { getRawFlagState: async (key) => ({ available: true,
    present: key === "raceListSqlSummaryV1Enabled",
    value: key === "raceListSqlSummaryV1Enabled" ? false : undefined }),
  setFlagsAtomically: async (entries) => writes.push(entries), bustCache() {} };
  const prisma = { appSetting: { deleteMany: async ({ where }) => deleted.push(where.key.in) } };
  const evidence = await pinRacesTabSettings({ prisma, settings });
  assert.deepEqual(evidence.intended, { apiRaceListCompactV1Enabled: true,
    redisCacheRaceListEnabled: true, raceListSqlSummaryV1Enabled: true });
  await restoreRacesTabSettings({ prisma, settings, evidence });
  assert.deepEqual(writes[0], Object.entries(evidence.intended));
  assert.deepEqual(writes[1], [["apiRaceListCompactV1Enabled", false],
    ["redisCacheRaceListEnabled", false], ["raceListSqlSummaryV1Enabled", false]]);
  assert.deepEqual(deleted[0], ["apiRaceListCompactV1Enabled", "redisCacheRaceListEnabled"]);
  assert.equal(evidence.restored, true);
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
    minimumMeasuredSessions: 4,
    maximumCoverageAugmentationShare: 1,
    requiredCoverageVariants: ["ordinary_classic_active"],
    settingsManager: { getRawFlagState: async () => ({ available: true, present: false }),
      setFlagsAtomically: async () => {}, bustCache() {} },
    readSourceCensus: async () => ({ schema: "races-tab-source-census-v2",
      sourceTimestamp: "2026-09-03T10:00:00.000Z", counts: {}, sourceHash: "b".repeat(64) }),
    materializeFullPageFixtures: async () => ({
      manifestIds: {}, naturallyGenerated: {}, augmented: {}, sourceZeroVariants: [],
    }),
    buildExpectedProjection: async ({ user }) => ({ marker: user.id }),
  });
  assert.equal(fixture.users.filter((user) => user.zeroFriends).length, 2);
  assert.ok(fixture.users.every((user) => user.token.startsWith("token-")));
  assert.equal(friendships.length, 1);
  assert.equal(fixture.topology.zeroFriendsShare, 0.5);
  assert.match(fixture.topology.friendDistributionSourceHash, /^[a-f0-9]{64}$/);
  assert.deepEqual(fixture.topology.modeledStateProfile, {
    schema: "races-tab-modeled-state-profile-v2",
    included: ["active", "pending", "completed", "invited", "tournament",
      "team-race", "pinned", "placement", "inventory", "active-effect",
      "discovery-public-count", "zero-friends"],
    excludedOffScreen: ["cancelled-tournament", "review-opportunity", "payout-double"],
  });
  assert.equal(fixture.topology.preScanState.stableFingerprint.length, 64);
  assert.equal(fixture.topology.schema, "races-tab-open-fixture-topology-v2");
  assert.equal(Object.hasOwn(fixture.topology.coverage, "byUser"), false);
  assert.equal(Object.hasOwn(fixture.topology.coverage, "rowTargetsByUser"), false);
  assert.equal(fixture.users[0].expectedProjection.marker, "u0");
  assert.equal(fixture.users[0].expectedProjectionVersion,
    "races-tab-open-projection-v2");
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
