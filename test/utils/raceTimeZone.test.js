const { test } = require("node:test");
const assert = require("node:assert");
const { raceTimeZone } = require("../../src/utils/raceTimeZone");

test("returns the race's canonical timezone when set", () => {
  assert.strictEqual(
    raceTimeZone({ timezone: "America/New_York" }, "UTC"),
    "America/New_York"
  );
});

test("falls back when timezone is null (user-created race)", () => {
  assert.strictEqual(raceTimeZone({ timezone: null }, "UTC"), "UTC");
  assert.strictEqual(
    raceTimeZone({ timezone: null }, "America/Los_Angeles"),
    "America/Los_Angeles"
  );
});

test("falls back when timezone is missing or empty", () => {
  assert.strictEqual(raceTimeZone({}, "UTC"), "UTC");
  assert.strictEqual(raceTimeZone({ timezone: "" }, "UTC"), "UTC");
  assert.strictEqual(raceTimeZone({ timezone: "   " }, "UTC"), "UTC");
});

test("falls back when race is null/undefined", () => {
  assert.strictEqual(raceTimeZone(null, "UTC"), "UTC");
  assert.strictEqual(raceTimeZone(undefined, "UTC"), "UTC");
});
