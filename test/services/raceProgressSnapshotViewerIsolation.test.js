const assert = require("node:assert/strict");
const test = require("node:test");

const snapshotStore = require("../../src/modules/races/services/raceProgressSnapshot");
const cacheKeys = require("../../src/shared/cache/cacheKeys");

test("legacy and lean race snapshots cannot overwrite each other", () => {
  assert.equal(cacheKeys.raceProgress("race-1"), "v1:race:progress:race-1");
  assert.equal(
    cacheKeys.raceProgress("race-1", snapshotStore.LEAN_SCHEMA_VERSION),
    "v1:race:progress:race-1:lean-v3"
  );
  assert.notEqual(
    cacheKeys.raceProgressLock("race-1", snapshotStore.SCHEMA_VERSION),
    cacheKeys.raceProgressLock("race-1", snapshotStore.LEAN_SCHEMA_VERSION)
  );
  assert.deepEqual(cacheKeys.raceProgressVariants("race-1"), [
    "v1:race:progress:race-1",
    "v1:race:progress:race-1:lean-v3",
  ]);
});

test("shared race snapshots never persist a viewer-specific global event", () => {
  const snapshot = snapshotStore.buildSnapshot({
    race: { raceId: "race-1", status: "ACTIVE" },
    participants: [],
    scoringTimeZone: "UTC",
    asOf: new Date("2026-08-20T14:00:00.000Z"),
    globalEvent: {
      active: true,
      multiplier: 2,
      endsAt: new Date("2026-08-20T14:30:00.000Z"),
    },
  });

  assert.equal(Object.hasOwn(snapshot, "globalEvent"), false);
});
