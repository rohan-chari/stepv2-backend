const assert = require("node:assert/strict");
const test = require("node:test");

const { computeBoxEffectiveSteps } = require("../../src/utils/boxSteps");

// Box progress = RAW walked steps (baseAdjusted) + the bonus high-water. It takes
// NO effect-multiplier inputs at all, so it is inherently immune to every buff
// (Runner's High, Campfire, 2x global event) and debuff (Leg Cramp, Wrong Turn) —
// those only move the leaderboard total, never box progress.

test("box steps = baseAdjusted + bonus high-water", () => {
  assert.equal(
    computeBoxEffectiveSteps({ baseAdjusted: 6000, bonusSteps: 1000, maxBonusSteps: 1000 }),
    7000
  );
});

test("bonus-steal pushback is protected by the high-water (uses max(bonus, maxBonus))", () => {
  // bonus stolen down to 200 but peaked at 1500 -> box keeps crediting 1500.
  assert.equal(
    computeBoxEffectiveSteps({ baseAdjusted: 6000, bonusSteps: 200, maxBonusSteps: 1500 }),
    7500
  );
});

test("a higher current bonus than the recorded high-water still counts", () => {
  assert.equal(
    computeBoxEffectiveSteps({ baseAdjusted: 6000, bonusSteps: 1800, maxBonusSteps: 1500 }),
    7800
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
