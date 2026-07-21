const assert = require("node:assert/strict");
const test = require("node:test");

const {
  getFinishRewardConfig,
  computeFinishRewardPool,
  computeFinishRewardPlaces,
} = require("../../src/modules/races/constants/raceFinishReward");
const { computeGradedPayouts } = require("../../src/modules/races/racePayoutPresets");

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
  // Small fields sit on the floor; the pool then grows per head (15/head) until
  // it hits the minting cap, after which more racers don't mint more coins.
  assert.equal(computeFinishRewardPool("seed-daily-10k", 1), 100); // floor
  assert.equal(computeFinishRewardPool("seed-daily-10k", 6), 100); // 90 -> floor
  assert.equal(computeFinishRewardPool("seed-daily-10k", 20), 300); // 15 * 20
  assert.equal(computeFinishRewardPool("seed-daily-10k", 100), 1500); // cap
  assert.equal(computeFinishRewardPool("seed-daily-10k", 500), 1500); // still cap
});

test("daily paid places are concentrated and the tail floor keeps the last place >= 10", () => {
  // paidFraction is now 0.5, but the minTailPayout floor pulls the place count
  // back down so the last paid place always clears 10 coins (via the descending
  // linear split). A 2-arg call derives the pool itself, so it still floors.
  assert.equal(computeFinishRewardPlaces("seed-daily-10k", 1), 1); // solo: just them
  assert.equal(computeFinishRewardPlaces("seed-daily-10k", 2), 2); // capped to field
  assert.equal(computeFinishRewardPlaces("seed-daily-10k", 6), 3); // floor (minPlaces)
  assert.equal(computeFinishRewardPlaces("seed-daily-10k", 15), 6); // ceil(0.5*15)=8 -> 6 for tail>=10
  assert.equal(computeFinishRewardPlaces("seed-daily-10k", 20), 7); // ceil(0.5*20)=10 -> 7 for tail>=10
  assert.equal(computeFinishRewardPlaces("seed-daily-10k", 30), 9); // ceil(0.5*30)=15 -> 9 for tail>=10
  assert.equal(computeFinishRewardPlaces("seed-daily-10k", 50), 11); // 15 -> 11 for tail>=10
  assert.equal(computeFinishRewardPlaces("seed-daily-10k", 100), 15); // cap, NOT 50
  assert.equal(computeFinishRewardPlaces("seed-daily-10k", 500), 15); // still cap
});

test("daily tail floor: last paid place always earns >= minTailPayout and the split sums to the pool", () => {
  // End-to-end check that the reduced place count actually yields a last-place
  // share >= 10 under the real descending-linear split used at settlement.
  for (const n of [5, 10, 15, 20, 30, 50, 100]) {
    const pool = computeFinishRewardPool("seed-daily-10k", n);
    const places = computeFinishRewardPlaces("seed-daily-10k", n, pool);
    const payouts = computeGradedPayouts({ pool, count: places });
    const sum = payouts.reduce((acc, x) => acc + x, 0);
    assert.equal(payouts.length, places, `places match payout length for n=${n}`);
    assert.equal(sum, pool, `split sums to pool for n=${n}`);
    assert.ok(
      payouts[payouts.length - 1] >= 10,
      `last place (${payouts[payouts.length - 1]}) >= 10 for n=${n}`
    );
    assert.ok(places >= 3, `never below minPlaces for n=${n}`);
  }
});

test("daily tail floor exact payout tables (fields 5/10/20/30/50/100)", () => {
  const table = (n) => {
    const pool = computeFinishRewardPool("seed-daily-10k", n);
    const places = computeFinishRewardPlaces("seed-daily-10k", n, pool);
    return computeGradedPayouts({ pool, count: places });
  };
  assert.deepEqual(table(5), [51, 33, 16]);
  assert.deepEqual(table(10), [50, 40, 30, 20, 10]);
  assert.deepEqual(table(20), [78, 64, 53, 42, 32, 21, 10]);
  assert.deepEqual(table(30), [90, 80, 70, 60, 50, 40, 30, 20, 10]);
  assert.deepEqual(table(50), [130, 113, 102, 90, 79, 68, 56, 45, 34, 22, 11]);
  assert.deepEqual(
    table(100),
    [191, 175, 162, 150, 137, 125, 112, 100, 87, 75, 62, 50, 37, 25, 12]
  );
});

test("minTailPayout reduction never drops below minPlaces even with a tiny pool", () => {
  // Passing an artificially tiny explicit pool forces every place's linear share
  // below the floor; the reduction must still stop at minPlaces (3), never lower.
  assert.equal(computeFinishRewardPlaces("seed-daily-10k", 20, 30), 3);
  assert.equal(computeFinishRewardPlaces("seed-daily-10k", 100, 5), 3);
  assert.equal(computeFinishRewardPlaces("seed-daily-10k", 50, 1), 3);
});

test("a field smaller than the place budget pays exactly the field, unaffected by the floor", () => {
  // 2 finishers -> 2 places (already <= minPlaces, no reduction applies).
  assert.equal(computeFinishRewardPlaces("seed-daily-10k", 2), 2);
  assert.equal(computeFinishRewardPlaces("seed-daily-10k", 1), 1);
});

test("the weekly seed has no tail floor (legacy behavior, unchanged)", () => {
  // seed-weekly-50k defines no minTailPayout, so its place count is purely the
  // clamped paidFraction with no reduction — a 100-field weekly still pays 20.
  assert.equal(getFinishRewardConfig("seed-weekly-50k").minTailPayout, undefined);
  assert.equal(computeFinishRewardPlaces("seed-weekly-50k", 100), 20);
  assert.equal(computeFinishRewardPlaces("seed-weekly-50k", 100, 4000), 20);
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
  assert.equal(computeFinishRewardPool("seed-daily-10k", 20.9), 300); // floor(20.9)=20 -> 15*20
  assert.equal(computeFinishRewardPlaces("seed-daily-10k", 20.9), 7);
  assert.equal(computeFinishRewardPool("seed-daily-10k", -5), 0);
  assert.equal(computeFinishRewardPlaces("seed-daily-10k", -5), 0);
});
