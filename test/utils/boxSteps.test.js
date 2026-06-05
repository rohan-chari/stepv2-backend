const assert = require("node:assert/strict");
const test = require("node:test");

const { computeBoxEffectiveSteps } = require("../../src/utils/boxSteps");

// Box progress = RAW walked steps (baseAdjusted) + the bonus high-water. It takes
// NO effect-multiplier inputs at all, so it is inherently immune to every buff
// (Runner's High, Campfire, 2x global event) and debuff (Leg Cramp, Wrong Turn) —
// those only move the leaderboard total, never box progress.

test("box steps = baseAdjusted only (bonus is excluded)", () => {
  assert.equal(
    computeBoxEffectiveSteps({ baseAdjusted: 6000, bonusSteps: 1000, maxBonusSteps: 1000 }),
    6000
  );
});

test("bonus-steal pushback does not affect box progress (bonus is excluded)", () => {
  // bonus stolen down to 200 but peaked at 1500 -> box still credits raw steps only.
  assert.equal(
    computeBoxEffectiveSteps({ baseAdjusted: 6000, bonusSteps: 200, maxBonusSteps: 1500 }),
    6000
  );
});

test("a higher current bonus than the recorded high-water still does not count", () => {
  assert.equal(
    computeBoxEffectiveSteps({ baseAdjusted: 6000, bonusSteps: 1800, maxBonusSteps: 1500 }),
    6000
  );
});

test("only baseAdjusted matters when there is no bonus (buffs/debuffs are not inputs)", () => {
  // A buffed leaderboard total would be much higher; box progress ignores it.
  assert.equal(computeBoxEffectiveSteps({ baseAdjusted: 4200 }), 4200);
});

test("clamps to >= 0 and has safe defaults", () => {
  assert.equal(computeBoxEffectiveSteps({ baseAdjusted: -100 }), 0);
  assert.equal(computeBoxEffectiveSteps(), 0);
});
