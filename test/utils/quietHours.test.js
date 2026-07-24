const assert = require("node:assert/strict");
const { test } = require("node:test");
const {
  isInQuietHours,
  isDrillSergeantQuietHours,
  DRILL_SERGEANT_QUIET_START_MIN,
  DRILL_SERGEANT_QUIET_END_MIN,
} = require("../../src/modules/powerups/constants/quietHours");
const { zonedDateTimeToUtc } = require("../../src/shared/time/week");

const S = DRILL_SERGEANT_QUIET_START_MIN; // 1320 (22:00)
const E = DRILL_SERGEANT_QUIET_END_MIN; //    420 (07:00)

// Build the UTC instant that reads as the given wall-clock in `tz`, so the
// helper reads back exactly that wall-clock (round-trip via zonedDateTimeToUtc).
function at(tz, y, mo, d, h, mi) {
  return zonedDateTimeToUtc(
    { year: y, month: mo, day: d, hour: h, minute: mi, second: 0 },
    tz
  );
}

const NY = "America/New_York";

test("Drill Sergeant window: inside sleep hours (23:00, 02:00, 06:59)", () => {
  assert.equal(isDrillSergeantQuietHours(at(NY, 2026, 7, 15, 23, 0), NY), true);
  assert.equal(isDrillSergeantQuietHours(at(NY, 2026, 7, 15, 2, 0), NY), true);
  assert.equal(isDrillSergeantQuietHours(at(NY, 2026, 7, 15, 6, 59), NY), true);
});

test("Drill Sergeant window: awake hours (12:00, 07:00 edge, 21:59 edge)", () => {
  assert.equal(isDrillSergeantQuietHours(at(NY, 2026, 7, 15, 12, 0), NY), false);
  // 07:00 is the exclusive end — awake.
  assert.equal(isDrillSergeantQuietHours(at(NY, 2026, 7, 15, 7, 0), NY), false);
  // 21:59 is one minute before the inclusive start — awake.
  assert.equal(isDrillSergeantQuietHours(at(NY, 2026, 7, 15, 21, 59), NY), false);
});

test("22:00 start is inclusive (asleep)", () => {
  assert.equal(isDrillSergeantQuietHours(at(NY, 2026, 7, 15, 22, 0), NY), true);
});

test("null / invalid / missing timezone returns null (caller falls through)", () => {
  assert.equal(isDrillSergeantQuietHours(new Date(), null), null);
  assert.equal(isDrillSergeantQuietHours(new Date(), ""), null);
  assert.equal(isDrillSergeantQuietHours(new Date(), "Not/AZone"), null);
});

test("empty window (start === end) is always false", () => {
  assert.equal(isInQuietHours(new Date(), NY, 600, 600), false);
});

test("non-wrapping window [08:00, 22:00) sanity", () => {
  const start = 8 * 60;
  const end = 22 * 60;
  assert.equal(isInQuietHours(at(NY, 2026, 7, 15, 12, 0), NY, start, end), true);
  assert.equal(isInQuietHours(at(NY, 2026, 7, 15, 7, 59), NY, start, end), false);
  assert.equal(isInQuietHours(at(NY, 2026, 7, 15, 22, 0), NY, start, end), false);
});

// DST transition days: the window is judged by the wall clock the target sees.
test("DST spring-forward day (2026-03-08 America/New_York): 23:00 asleep, 12:00 awake", () => {
  // Spring forward is 2026-03-08 (2:00 -> 3:00 EDT).
  assert.equal(isDrillSergeantQuietHours(at(NY, 2026, 3, 8, 23, 0), NY), true);
  assert.equal(isDrillSergeantQuietHours(at(NY, 2026, 3, 8, 12, 0), NY), false);
});

test("DST fall-back day (2026-11-01 America/New_York): 01:30 asleep, 12:00 awake", () => {
  // Fall back is 2026-11-01 (2:00 -> 1:00 EST). 01:30 exists twice; either is asleep.
  assert.equal(isDrillSergeantQuietHours(at(NY, 2026, 11, 1, 1, 30), NY), true);
  assert.equal(isDrillSergeantQuietHours(at(NY, 2026, 11, 1, 12, 0), NY), false);
});

test("window uses the TARGET zone, not UTC — same instant differs by zone", () => {
  // 2026-07-15T04:00Z is 00:00 in NY (asleep) but 13:00 in Asia/Kolkata (awake).
  const instant = new Date("2026-07-15T04:00:00.000Z");
  assert.equal(isInQuietHours(instant, NY, S, E), true);
  assert.equal(isInQuietHours(instant, "Asia/Kolkata", S, E), false);
});
