const assert = require("node:assert/strict");
const test = require("node:test");

const {
  RACE_PAYOUT_PRESETS,
  computeFundedPayouts,
} = require("../../src/modules/races/racePayoutPresets");

// Seeded challenge top-heavy payouts (spec §7 test 17). The geometric curve is
// only reachable through computeFundedPayouts, so the invariants are pinned on
// the public path rather than on the private distributeGeometric helper.

const POOL = 6000;
const SLOTS_FIELD = 300; // TOP_HALF of 300 -> 150 paid places

function geometric(participantCount, poolCoins = POOL) {
  return computeFundedPayouts({
    preset: RACE_PAYOUT_PRESETS.TOP_HALF,
    poolCoins,
    participantCount,
    curve: "GEOMETRIC",
  });
}

test("a NULL curve keeps the even split (today's behavior)", () => {
  const even = computeFundedPayouts({
    preset: RACE_PAYOUT_PRESETS.TOP_HALF,
    poolCoins: POOL,
    participantCount: SLOTS_FIELD,
  });
  assert.equal(even.length, 150);
  assert.ok(even.every((amount) => amount === even[1]) || even[0] >= even[1]);
  assert.equal(new Set(even.slice(1)).size, 1, "all lower places equal");
  assert.equal(
    even.reduce((sum, amount) => sum + amount, 0),
    POOL
  );
});

test("an unknown curve string falls back to the even split", () => {
  const amounts = computeFundedPayouts({
    preset: RACE_PAYOUT_PRESETS.TOP_HALF,
    poolCoins: POOL,
    participantCount: SLOTS_FIELD,
    curve: "SOMETHING_ELSE",
  });
  assert.equal(new Set(amounts.slice(1)).size, 1);
});

test("GEOMETRIC pays 150 slots: sums to the pool, monotonic, floor respected", () => {
  const amounts = geometric(SLOTS_FIELD);

  assert.equal(amounts.length, 150, "slot count is unchanged by the curve");
  assert.equal(
    amounts.reduce((sum, amount) => sum + amount, 0),
    POOL,
    "sums to exactly the stamped pool"
  );
  for (let i = 1; i < amounts.length; i++) {
    assert.ok(
      amounts[i - 1] >= amounts[i],
      `place ${i} (${amounts[i]}) must not exceed place ${i} above (${amounts[i - 1]})`
    );
  }
  assert.ok(
    amounts.every((amount) => amount >= 1),
    "every paid place clears the 1-coin floor"
  );
  assert.ok(amounts[0] > POOL / 150, "1st beats the even share");
  // ~30% of the pool to 1st is the whole point of the curve.
  assert.ok(amounts[0] > POOL * 0.25 && amounts[0] < POOL * 0.35);
});

test("GEOMETRIC is numerically sound at the 16,000-coin cap and a huge field", () => {
  const amounts = computeFundedPayouts({
    preset: RACE_PAYOUT_PRESETS.TOP_HALF,
    poolCoins: 16000,
    participantCount: 2000,
    curve: "GEOMETRIC",
  });
  assert.equal(amounts.length, 1000);
  assert.equal(
    amounts.reduce((sum, amount) => sum + amount, 0),
    16000
  );
  assert.ok(amounts.every((amount) => amount >= 1 && Number.isFinite(amount)));
});

test("GEOMETRIC leaves the fixed-percentage presets alone", () => {
  assert.deepEqual(
    computeFundedPayouts({
      preset: RACE_PAYOUT_PRESETS.WINNER_TAKES_ALL,
      poolCoins: 400,
      participantCount: 10,
      curve: "GEOMETRIC",
    }),
    [400]
  );
  assert.deepEqual(
    computeFundedPayouts({
      preset: RACE_PAYOUT_PRESETS.TOP3_70_20_10,
      poolCoins: 400,
      participantCount: 10,
      curve: "GEOMETRIC",
    }),
    computeFundedPayouts({
      preset: RACE_PAYOUT_PRESETS.TOP3_70_20_10,
      poolCoins: 400,
      participantCount: 10,
    })
  );
});

test("GEOMETRIC on an empty pool or a field of one pays nothing", () => {
  assert.deepEqual(geometric(300, 0), []);
  assert.deepEqual(geometric(1), []);
});
