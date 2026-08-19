const assert = require("node:assert/strict");
const test = require("node:test");

const snapshotStore = require("../../src/modules/races/services/raceProgressSnapshot");

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
