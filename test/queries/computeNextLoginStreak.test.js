const assert = require("node:assert/strict");
const test = require("node:test");

const {
  computeNextLoginStreak,
} = require("../../src/queries/getDailyRewardStatus");

test("first ever claim starts streak at 1", () => {
  assert.equal(computeNextLoginStreak(null, 0, 0, "2026-06-10"), 1);
});

test("consecutive day increments streak", () => {
  assert.equal(computeNextLoginStreak("2026-06-09", 4, 0, "2026-06-10"), 5);
});

test("missed day resets streak to 1", () => {
  assert.equal(computeNextLoginStreak("2026-06-08", 12, 3, "2026-06-10"), 1);
});

test("already claimed today keeps current streak", () => {
  assert.equal(computeNextLoginStreak("2026-06-10", 7, 2, "2026-06-10"), 7);
});

test("seeds from legacy cycle day when login streak column is fresh", () => {
  // User was mid-cycle on an old build (dailyStreakDay=5) when the column
  // shipped (dailyLoginStreak=0): next consecutive claim continues at 6.
  assert.equal(computeNextLoginStreak("2026-06-09", 0, 5, "2026-06-10"), 6);
});

test("streak crosses month boundary", () => {
  assert.equal(computeNextLoginStreak("2026-05-31", 9, 0, "2026-06-01"), 10);
});

test("unbounded past the legacy 6-day cycle", () => {
  assert.equal(computeNextLoginStreak("2026-06-09", 17, 6, "2026-06-10"), 18);
});
