const assert = require("node:assert/strict");
const test = require("node:test");

const { computeGradedPayouts } = require("../../src/utils/racePayoutPresets");

test("computeGradedPayouts gives the whole pool to a solo finisher", () => {
  assert.deepEqual(computeGradedPayouts({ pool: 100, count: 1 }), [100]);
  assert.deepEqual(computeGradedPayouts({ pool: 500, count: 1 }), [500]);
});

test("computeGradedPayouts splits the daily pool across the top 3 by descending weight", () => {
  // weights 3:2:1 of 100 → 50/33/16, remainder (1) to first
  assert.deepEqual(computeGradedPayouts({ pool: 100, count: 3 }), [51, 33, 16]);
});

test("computeGradedPayouts splits the weekly pool across the top 5", () => {
  // weights 5:4:3:2:1 of 500 → 166/133/100/66/33, remainder (2) to first
  assert.deepEqual(
    computeGradedPayouts({ pool: 500, count: 5 }),
    [168, 133, 100, 66, 33]
  );
});

test("computeGradedPayouts never exceeds the pool and distributes all of it", () => {
  for (const pool of [100, 500, 137, 1000]) {
    for (const count of [1, 2, 3, 5, 8, 13]) {
      const amounts = computeGradedPayouts({ pool, count });
      const sum = amounts.reduce((acc, n) => acc + n, 0);
      assert.equal(sum, pool, `sum should equal pool for pool=${pool} count=${count}`);
      assert.equal(amounts.length, count);
    }
  }
});

test("computeGradedPayouts is non-increasing — higher placers never earn less", () => {
  const amounts = computeGradedPayouts({ pool: 500, count: 6 });
  for (let i = 1; i < amounts.length; i++) {
    assert.ok(
      amounts[i - 1] >= amounts[i],
      `rank ${i} (${amounts[i - 1]}) should be >= rank ${i + 1} (${amounts[i]})`
    );
  }
});

test("computeGradedPayouts returns nothing for an empty pool or zero slots", () => {
  assert.deepEqual(computeGradedPayouts({ pool: 0, count: 5 }), []);
  assert.deepEqual(computeGradedPayouts({ pool: 100, count: 0 }), []);
  assert.deepEqual(computeGradedPayouts({ pool: null, count: null }), []);
});
