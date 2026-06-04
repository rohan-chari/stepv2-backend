const assert = require("node:assert/strict");
const test = require("node:test");

const { computeBoxEffectiveSteps } = require("../../src/utils/boxSteps");

// Box progress is IMMUNE to Leg Cramp (frozen) and Wrong Turn (reversed): both
// penalties are added back on top of the leaderboard total. Bonus-steal stays
// protected via the maxBonus high-water.

test("adds back Leg Cramp frozen + 2x Wrong Turn reversed", () => {
  // total already had -frozen and -2*reversed baked in; add the Leg-Cramp slice
  // (300) and 2x the reversal (2*100) back.
  assert.equal(
    computeBoxEffectiveSteps({
      total: 5000,
      legCrampFrozenSteps: 300,
      reversedSteps: 100,
      bonusSteps: 0,
      maxBonusSteps: 0,
    }),
    5000 + 300 + 200
  );
});

test("Campfire freeze is NOT added back (only the Leg-Cramp slice is passed)", () => {
  // Caller passes legCrampFrozenSteps = Leg-Cramp portion only; Campfire freeze
  // stays subtracted in `total`, so it is not restored here.
  assert.equal(
    computeBoxEffectiveSteps({ total: 4000, legCrampFrozenSteps: 0, reversedSteps: 0 }),
    4000
  );
});

test("bonus-steal pushback stays protected via the maxBonus high-water", () => {
  // bonus dropped to -500 but peaked at 0 => protection adds 500 back.
  assert.equal(
    computeBoxEffectiveSteps({ total: 5000, bonusSteps: -500, maxBonusSteps: 0 }),
    5500
  );
});

test("clamps to >= 0", () => {
  assert.equal(computeBoxEffectiveSteps({ total: -100 }), 0);
});

test("no args / no effects => total only (safe defaults)", () => {
  assert.equal(computeBoxEffectiveSteps({ total: 4200 }), 4200);
  assert.equal(computeBoxEffectiveSteps(), 0);
});
