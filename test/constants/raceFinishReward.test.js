const assert = require("node:assert/strict");
const test = require("node:test");

const {
  getFinishRewardConfig,
  computeFinishRewardPool,
  computeFinishRewardPlaces,
} = require("../../src/constants/raceFinishReward");

// ---------------------------------------------------------------------------
// Seeded daily/weekly finish rewards are MINTED, and both knobs respond to the
// field size:
//   * the pool grows with the number of finishers (more racers -> bigger prize),
//     clamped between a floor and a minting cap, and
//   * the number of paid places is CONCENTRATED (a small fraction of the field,
//     clamped to a max) so each share stays meaningful instead of dissolving
//     into a long tail of 0/1-coin "winners".
// ---------------------------------------------------------------------------

test("getFinishRewardConfig returns a config for seeded races only", () => {
  assert.ok(getFinishRewardConfig("seed-daily-10k"));
  assert.ok(getFinishRewardConfig("seed-weekly-50k"));
  assert.equal(getFinishRewardConfig("seed-unknown"), null);
  assert.equal(getFinishRewardConfig(null), null);
  assert.equal(getFinishRewardConfig(undefined), null);
});

test("a non-seeded race mints nothing and pays no places", () => {
  assert.equal(computeFinishRewardPool(null, 50), 0);
  assert.equal(computeFinishRewardPool("seed-unknown", 50), 0);
  assert.equal(computeFinishRewardPlaces(null, 50), 0);
  assert.equal(computeFinishRewardPlaces("seed-unknown", 50), 0);
});

test("an empty field mints nothing", () => {
  assert.equal(computeFinishRewardPool("seed-daily-10k", 0), 0);
  assert.equal(computeFinishRewardPlaces("seed-daily-10k", 0), 0);
});

test("daily pool scales with the field, clamped between floor and cap", () => {
  // Small fields sit on the floor; the pool then grows per head until it hits
  // the minting cap, after which more racers don't mint more coins.
  assert.equal(computeFinishRewardPool("seed-daily-10k", 1), 100); // floor
  assert.equal(computeFinishRewardPool("seed-daily-10k", 6), 100); // 72 -> floor
  assert.equal(computeFinishRewardPool("seed-daily-10k", 20), 240); // 12 * 20
  assert.equal(computeFinishRewardPool("seed-daily-10k", 100), 1200); // cap
  assert.equal(computeFinishRewardPool("seed-daily-10k", 500), 1200); // still cap
});

test("daily paid places are concentrated, not half the field", () => {
  // The whole point: a 100-person daily must NOT pay 50 places. It pays a small,
  // capped number so each winner gets a real reward.
  assert.equal(computeFinishRewardPlaces("seed-daily-10k", 1), 1); // solo: just them
  assert.equal(computeFinishRewardPlaces("seed-daily-10k", 2), 2); // capped to field
  assert.equal(computeFinishRewardPlaces("seed-daily-10k", 6), 3); // floor (minPlaces)
  assert.equal(computeFinishRewardPlaces("seed-daily-10k", 20), 4); // ceil(0.2 * 20)
  assert.equal(computeFinishRewardPlaces("seed-daily-10k", 100), 10); // cap, NOT 50
  assert.equal(computeFinishRewardPlaces("seed-daily-10k", 500), 10); // still cap
});

test("weekly uses larger pool + place budgets than daily", () => {
  assert.equal(computeFinishRewardPool("seed-weekly-50k", 1), 500); // floor
  assert.equal(computeFinishRewardPool("seed-weekly-50k", 20), 800); // 40 * 20
  assert.equal(computeFinishRewardPool("seed-weekly-50k", 100), 4000); // 40 * 100
  assert.equal(computeFinishRewardPool("seed-weekly-50k", 200), 5000); // cap

  assert.equal(computeFinishRewardPlaces("seed-weekly-50k", 10), 3); // floor
  assert.equal(computeFinishRewardPlaces("seed-weekly-50k", 100), 20); // cap
  assert.equal(computeFinishRewardPlaces("seed-weekly-50k", 500), 20); // still cap
});

test("paid places never exceed the field size", () => {
  for (let n = 1; n <= 30; n++) {
    assert.ok(
      computeFinishRewardPlaces("seed-daily-10k", n) <= n,
      `places for field ${n} should not exceed ${n}`
    );
    assert.ok(
      computeFinishRewardPlaces("seed-weekly-50k", n) <= n,
      `weekly places for field ${n} should not exceed ${n}`
    );
  }
});

test("non-integer / sloppy field counts are floored defensively", () => {
  assert.equal(computeFinishRewardPool("seed-daily-10k", 20.9), 240);
  assert.equal(computeFinishRewardPlaces("seed-daily-10k", 20.9), 4);
  assert.equal(computeFinishRewardPool("seed-daily-10k", -5), 0);
  assert.equal(computeFinishRewardPlaces("seed-daily-10k", -5), 0);
});
