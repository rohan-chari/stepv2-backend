const assert = require("node:assert/strict");
const test = require("node:test");
const {
  buildGetActiveRaceImpactNotices,
} = require("../../src/modules/races/queries/getActiveRaceImpactNotices");

test("passes the optional client cutoff to the indexed notice query", async () => {
  let args;
  const getActiveRaceImpactNotices = buildGetActiveRaceImpactNotices({
    RaceImpactEvent: {
      async getRaceAccess() {
        return { status: "ACTIVE", participants: [{ id: "p1" }] };
      },
      async listUnacknowledged(input) {
        args = input;
        return [];
      },
    },
  });
  const resolvedAfter = new Date("2026-08-23T12:00:00.000Z");

  await getActiveRaceImpactNotices({
    raceId: "race-1",
    userId: "user-1",
    resolvedAfter,
  });

  assert.equal(args.resolvedAfter, resolvedAfter);
  assert.equal(args.limit, 20);
});

test("omitted cutoff preserves the legacy query shape", async () => {
  let args;
  const getActiveRaceImpactNotices = buildGetActiveRaceImpactNotices({
    RaceImpactEvent: {
      async getRaceAccess() {
        return { status: "ACTIVE", participants: [{ id: "p1" }] };
      },
      async listUnacknowledged(input) {
        args = input;
        return [];
      },
    },
  });

  await getActiveRaceImpactNotices({ raceId: "race-1", userId: "user-1" });

  assert.equal(args.resolvedAfter, null);
  assert.equal(args.limit, 20);
});
