const assert = require("node:assert/strict");
const test = require("node:test");
const {
  buildGetRaceDiscoverySummary,
} = require("../../src/modules/races/queries/getRaceDiscoverySummary");

const silentLogger = { error() {} };

test("aggregates all three branches with resolved=true", async () => {
  const summary = await buildGetRaceDiscoverySummary({
    getPublicRaceCount: async () => 7,
    getFeaturedRaces: async () => [{ raceId: "r1" }],
    getPublicTournaments: async () => ({ featured: [{ tournamentId: "t1" }] }),
    logger: silentLogger,
  })({ userId: "u1", supportsTournaments: true });

  assert.equal(summary.publicRaceCount, 7);
  assert.equal(summary.featuredRaces.length, 1);
  assert.equal(summary.featuredTournaments.length, 1);
  assert.deepEqual(summary.resolved, {
    publicRaceCount: true,
    featuredRaces: true,
    featuredTournaments: true,
  });
});

test("a failed branch isolates: safe default + only its resolved bit false", async () => {
  const summary = await buildGetRaceDiscoverySummary({
    getPublicRaceCount: async () => { throw new Error("db down"); },
    getFeaturedRaces: async () => [{ raceId: "r1" }],
    getPublicTournaments: async () => ({ featured: [] }),
    logger: silentLogger,
  })({ userId: "u1", supportsTournaments: true });

  // Failed public count → safe default 0, resolved false; others unaffected.
  assert.equal(summary.publicRaceCount, 0);
  assert.equal(summary.resolved.publicRaceCount, false);
  assert.equal(summary.resolved.featuredRaces, true);
  assert.equal(summary.featuredRaces.length, 1);
  assert.equal(summary.resolved.featuredTournaments, true);
});

test("missing tournaments capability → [] with resolved=true (known empty, not failed)", async () => {
  let tournamentsCalled = false;
  const summary = await buildGetRaceDiscoverySummary({
    getPublicRaceCount: async () => 3,
    getFeaturedRaces: async () => [],
    getPublicTournaments: async () => { tournamentsCalled = true; return { featured: [{}] }; },
    logger: silentLogger,
  })({ userId: "u1", supportsTournaments: false });

  assert.equal(tournamentsCalled, false);
  assert.deepEqual(summary.featuredTournaments, []);
  assert.equal(summary.resolved.featuredTournaments, true);
});

test("wrong-typed branch value is treated as unresolved with a safe default", async () => {
  const summary = await buildGetRaceDiscoverySummary({
    getPublicRaceCount: async () => "not a number",
    getFeaturedRaces: async () => "not an array",
    getPublicTournaments: async () => ({ featured: "nope" }),
    logger: silentLogger,
  })({ userId: "u1", supportsTournaments: true });

  assert.equal(summary.publicRaceCount, 0);
  assert.deepEqual(summary.featuredRaces, []);
  assert.deepEqual(summary.featuredTournaments, []);
  assert.deepEqual(summary.resolved, {
    publicRaceCount: false,
    featuredRaces: false,
    featuredTournaments: false,
  });
});
