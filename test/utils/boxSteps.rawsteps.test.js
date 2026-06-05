const assert = require("node:assert/strict");
const test = require("node:test");

const { computeBoxEffectiveSteps } = require("../../src/utils/boxSteps");

// Box progress = RAW walked steps (baseAdjusted) ONLY. Additive consumable bonuses
// (Protein Shake / Trail Mix / Second Wind) help the leaderboard total but must NOT
// bring a player closer to the next box, so bonusSteps/maxBonusSteps are ignored
// even though they are still accepted for signature compatibility. Box progress is
// also inherently immune to every buff/debuff multiplier — those only move the
// leaderboard total.

test("box steps = baseAdjusted only (bonus high-water is ignored)", () => {
  assert.equal(
    computeBoxEffectiveSteps({ baseAdjusted: 6000, bonusSteps: 1000, maxBonusSteps: 1000 }),
    6000
  );
});

test("a bonus-steal pushback does not change box progress (bonus ignored)", () => {
  assert.equal(
    computeBoxEffectiveSteps({ baseAdjusted: 6000, bonusSteps: 200, maxBonusSteps: 1500 }),
    6000
  );
});

test("a higher current bonus than the high-water still does not count", () => {
  assert.equal(
    computeBoxEffectiveSteps({ baseAdjusted: 6000, bonusSteps: 1800, maxBonusSteps: 1500 }),
    6000
  );
});

test("only baseAdjusted matters when there is no bonus", () => {
  assert.equal(computeBoxEffectiveSteps({ baseAdjusted: 4200 }), 4200);
});

test("box progress == max(0, baseAdjusted) regardless of bonus inputs", () => {
  assert.equal(
    computeBoxEffectiveSteps({ baseAdjusted: 4200, bonusSteps: 9999, maxBonusSteps: 9999 }),
    4200
  );
  assert.equal(
    computeBoxEffectiveSteps({ baseAdjusted: 0, bonusSteps: 5000, maxBonusSteps: 5000 }),
    0
  );
});

test("clamps to >= 0 and has safe defaults", () => {
  assert.equal(computeBoxEffectiveSteps({ baseAdjusted: -100 }), 0);
  assert.equal(computeBoxEffectiveSteps({ baseAdjusted: -100, bonusSteps: 500, maxBonusSteps: 500 }), 0);
  assert.equal(computeBoxEffectiveSteps(), 0);
});
