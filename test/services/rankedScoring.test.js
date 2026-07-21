const assert = require("node:assert/strict");
const test = require("node:test");

const { computeSeasonRp } = require("../../src/modules/ranked/services/rankedPoints");
const { computeStandings } = require("../../src/modules/ranked/services/rankedStandings");

// Build a Date at UTC midnight for a YYYY-MM-DD day (matches Step.date storage).
function d(day) {
  return new Date(`2026-05-${String(day).padStart(2, "0")}`);
}

test("computeSeasonRp matches the calibration formula (milestones + volume + streak)", () => {
  const rows = [
    { date: d(1), steps: 10000 }, // milestone 50 + volume 10 + streak day1 (0) = 60
    { date: d(2), steps: 6000 }, //  milestone 20 + volume 6  + streak day2 (5) = 31
    { date: d(3), steps: 4000 }, //  inactive: milestone 0 + volume 4 + 0       = 4
    { date: d(4), steps: 20000 }, // milestone 100 + volume 20 + streak reset(0) = 120
  ];

  const { earnedPoints, activeDays } = computeSeasonRp(rows);
  assert.equal(earnedPoints, 215);
  assert.equal(activeDays, 3);
});

test("computeSeasonRp caps the streak bonus at 50/day", () => {
  // 12 consecutive 5k days: streak bonus ramps 0,5,...,50 then stays 50.
  const rows = Array.from({ length: 12 }, (_, i) => ({ date: d(i + 1), steps: 5000 }));
  const { earnedPoints, activeDays } = computeSeasonRp(rows);
  // per day: milestone 20 + volume 5 = 25 base; streak bonuses: 0,5,10,...,50,50
  const streakBonuses = [0, 5, 10, 15, 20, 25, 30, 35, 40, 45, 50, 50];
  const expected = streakBonuses.reduce((sum, b) => sum + 25 + b, 0);
  assert.equal(activeDays, 12);
  assert.equal(earnedPoints, expected);
});

test("computeSeasonRp ignores order and is empty-safe", () => {
  assert.deepEqual(computeSeasonRp([]), { earnedPoints: 0, activeDays: 0 });
  const a = computeSeasonRp([{ date: d(2), steps: 6000 }, { date: d(1), steps: 10000 }]);
  const b = computeSeasonRp([{ date: d(1), steps: 10000 }, { date: d(2), steps: 6000 }]);
  assert.deepEqual(a, b);
});

test("computeStandings assigns fixed tiers by points and divisions", () => {
  // Calibrated thresholds: Silver>=200, Gold>=550, Diamond>=1400.
  const standings = computeStandings([
    { userId: "u_gold", points: 600, earnedPoints: 600, carryOverSeed: 0 }, // Gold III (550-832)
    { userId: "u_silver", points: 450, earnedPoints: 450, carryOverSeed: 0 }, // Silver I (433-549)
    { userId: "u_bronze", points: 150, earnedPoints: 150, carryOverSeed: 0 }, // Bronze I (133-199)
  ]);

  const byUser = Object.fromEntries(standings.map((s) => [s.userId, s]));
  assert.deepEqual([byUser.u_gold.tier, byUser.u_gold.division], ["GOLD", 3]);
  assert.deepEqual([byUser.u_silver.tier, byUser.u_silver.division], ["SILVER", 1]);
  assert.deepEqual([byUser.u_bronze.tier, byUser.u_bronze.division], ["BRONZE", 1]);
  // ranks are 1-based by points desc
  assert.equal(byUser.u_gold.rank, 1);
  assert.equal(byUser.u_bronze.rank, 3);
});

test("Diamond requires BOTH the floor AND a top-10% slot; otherwise caps at Gold I", () => {
  // 5 users → Diamond cutoff = ceil(5 * 0.10) = 1, so only rank 1 can be Diamond.
  const standings = computeStandings([
    { userId: "u_top", points: 2000, earnedPoints: 2000, carryOverSeed: 0 },
    { userId: "u_high", points: 1800, earnedPoints: 1800, carryOverSeed: 0 }, // >= floor but rank 2
    { userId: "c", points: 900, earnedPoints: 900, carryOverSeed: 0 },
    { userId: "d", points: 600, earnedPoints: 600, carryOverSeed: 0 },
    { userId: "e", points: 100, earnedPoints: 100, carryOverSeed: 0 },
  ]);
  const byUser = Object.fromEntries(standings.map((s) => [s.userId, s]));

  assert.deepEqual([byUser.u_top.tier, byUser.u_top.division], ["DIAMOND", null]);
  // Diamond-level points but outside the top slot → Gold I, not Diamond.
  assert.deepEqual([byUser.u_high.tier, byUser.u_high.division], ["GOLD", 1]);
});
