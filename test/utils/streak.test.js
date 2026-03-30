const assert = require("node:assert/strict");
const test = require("node:test");

const { calculateStreak } = require("../../src/utils/streak");

test("past days met locked goal but not current goal — streak counts them", () => {
  // Bug repro: user had goal 5000, walked 7000 for 3 days, then raised goal to 10000.
  // Old code used current goal (10000) for all days → streak 0.
  // Fixed code uses per-day locked goal (5000) → streak 3.
  const dateMap = new Map([
    ["2026-03-26", { steps: 7000, stepGoal: 5000 }],
    ["2026-03-27", { steps: 7500, stepGoal: 5000 }],
    ["2026-03-28", { steps: 7200, stepGoal: 5000 }],
    ["2026-03-29", { steps: 2000, stepGoal: 10000 }],
  ]);

  const streak = calculateStreak("2026-03-29", dateMap, 10000);
  assert.equal(streak, 3);
});

test("today not yet hit — shows previous days streak", () => {
  const dateMap = new Map([
    ["2026-03-26", { steps: 9000, stepGoal: 8000 }],
    ["2026-03-27", { steps: 8500, stepGoal: 8000 }],
    ["2026-03-28", { steps: 10000, stepGoal: 8000 }],
    ["2026-03-29", { steps: 3000, stepGoal: 8000 }],
  ]);

  const streak = calculateStreak("2026-03-29", dateMap, 8000);
  assert.equal(streak, 3);
});

test("today hit — adds to the streak", () => {
  const dateMap = new Map([
    ["2026-03-26", { steps: 9000, stepGoal: 8000 }],
    ["2026-03-27", { steps: 8500, stepGoal: 8000 }],
    ["2026-03-28", { steps: 10000, stepGoal: 8000 }],
    ["2026-03-29", { steps: 12000, stepGoal: 8000 }],
  ]);

  const streak = calculateStreak("2026-03-29", dateMap, 8000);
  assert.equal(streak, 4);
});

test("null stepGoal records fall back to defaultStepGoal", () => {
  const dateMap = new Map([
    ["2026-03-27", { steps: 6000, stepGoal: null }],
    ["2026-03-28", { steps: 7000, stepGoal: null }],
  ]);

  // Default goal is 5000, both days exceed it
  assert.equal(calculateStreak("2026-03-29", dateMap, 5000), 2);

  // Default goal is 8000, neither day meets it
  assert.equal(calculateStreak("2026-03-29", dateMap, 8000), 0);
});

test("mixed locked goals across days — each evaluated against its own", () => {
  const dateMap = new Map([
    ["2026-03-25", { steps: 6000, stepGoal: 5000 }],  // hit (6000 >= 5000)
    ["2026-03-26", { steps: 9000, stepGoal: 8000 }],  // hit (9000 >= 8000)
    ["2026-03-27", { steps: 7000, stepGoal: 8000 }],  // miss (7000 < 8000)
    ["2026-03-28", { steps: 6000, stepGoal: 5000 }],  // hit but after a gap
  ]);

  // Streak counts backward from yesterday (03-28): hit.
  // Then 03-27: miss → stop. Streak = 1.
  const streak = calculateStreak("2026-03-29", dateMap, 5000);
  assert.equal(streak, 1);
});

test("empty dateMap — streak is 0", () => {
  const streak = calculateStreak("2026-03-29", new Map(), 8000);
  assert.equal(streak, 0);
});

test("gap in days breaks the streak", () => {
  const dateMap = new Map([
    // 03-26 missing
    ["2026-03-25", { steps: 9000, stepGoal: 8000 }],
    ["2026-03-27", { steps: 9000, stepGoal: 8000 }],
    ["2026-03-28", { steps: 9000, stepGoal: 8000 }],
  ]);

  // Backward: 03-28 hit, 03-27 hit, 03-26 missing → stop. Streak = 2.
  const streak = calculateStreak("2026-03-29", dateMap, 8000);
  assert.equal(streak, 2);
});
