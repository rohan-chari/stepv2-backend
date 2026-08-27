const assert = require("node:assert/strict");
const test = require("node:test");

const {
  localDateKey,
  nextLocalMidnight,
} = require("../../src/modules/economy/lib/interstitialTime");

test("interstitial cap dates use the supplied IANA timezone", () => {
  const instant = new Date("2026-08-27T02:00:00.000Z");
  assert.equal(localDateKey(instant, "America/New_York"), "2026-08-26");
  assert.equal(localDateKey(instant, "UTC"), "2026-08-27");
});

test("next local midnight follows real DST gap and fold instants", () => {
  assert.equal(
    nextLocalMidnight(
      new Date("2026-03-08T06:30:00.000Z"),
      "America/New_York",
    ).toISOString(),
    "2026-03-09T04:00:00.000Z",
  );
  assert.equal(
    nextLocalMidnight(
      new Date("2026-11-01T04:30:00.000Z"),
      "America/New_York",
    ).toISOString(),
    "2026-11-02T05:00:00.000Z",
  );
});
