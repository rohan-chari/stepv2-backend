const assert = require("node:assert/strict");
const test = require("node:test");

const {
  DAILY_BOX_STREAK_CAP,
  DAILY_BOX_ODDS_TABLE,
  DAILY_BOX_COIN_RANGES,
  streakProgress,
  interpolateDailyBoxOdds,
  rollDailyBoxRarity,
  coinAmountForTier,
  pickAccessory,
} = require("../../src/utils/dailyBoxOdds");

test("streakProgress clamps to [0,1] across the cap", () => {
  assert.equal(streakProgress(1), 0);
  assert.equal(streakProgress(0), 0);
  assert.equal(streakProgress(undefined), 0);
  assert.equal(streakProgress(DAILY_BOX_STREAK_CAP), 1);
  assert.equal(streakProgress(DAILY_BOX_STREAK_CAP + 100), 1);
});

test("day-1 streak gets the 'first' odds row", () => {
  const odds = interpolateDailyBoxOdds(1);
  assert.deepEqual(odds, DAILY_BOX_ODDS_TABLE.first);
});

test("capped streak gets the 'last' odds row", () => {
  const odds = interpolateDailyBoxOdds(DAILY_BOX_STREAK_CAP);
  for (let i = 0; i < 3; i++) {
    assert.ok(Math.abs(odds[i] - DAILY_BOX_ODDS_TABLE.last[i]) < 1e-9);
  }
});

test("odds always sum to 1", () => {
  for (const streak of [1, 5, 10, 15, 30, 60]) {
    const odds = interpolateDailyBoxOdds(streak);
    const sum = odds[0] + odds[1] + odds[2];
    assert.ok(Math.abs(sum - 1) < 1e-9, `streak ${streak} sums to ${sum}`);
  }
});

test("rollDailyBoxRarity respects rng buckets at day 1", () => {
  assert.equal(rollDailyBoxRarity(1, () => 0), "COMMON");
  assert.equal(rollDailyBoxRarity(1, () => 0.71), "UNCOMMON");
  assert.equal(rollDailyBoxRarity(1, () => 0.96), "RARE");
});

test("long streak rolls more rares than day-1 streak", () => {
  let dayOneRares = 0;
  let cappedRares = 0;
  for (let i = 0; i < 2000; i++) {
    if (rollDailyBoxRarity(1) === "RARE") dayOneRares++;
    if (rollDailyBoxRarity(DAILY_BOX_STREAK_CAP) === "RARE") cappedRares++;
  }
  assert.ok(
    cappedRares > dayOneRares,
    `capped rares (${cappedRares}) should exceed day-1 rares (${dayOneRares})`
  );
});

test("coinAmountForTier scales from range min to range max with streak", () => {
  assert.equal(coinAmountForTier("COMMON", 1), DAILY_BOX_COIN_RANGES.COMMON[0]);
  assert.equal(
    coinAmountForTier("COMMON", DAILY_BOX_STREAK_CAP),
    DAILY_BOX_COIN_RANGES.COMMON[1]
  );
  assert.equal(
    coinAmountForTier("UNCOMMON", 1),
    DAILY_BOX_COIN_RANGES.UNCOMMON[0]
  );
  assert.equal(
    coinAmountForTier("RARE_FALLBACK", DAILY_BOX_STREAK_CAP),
    DAILY_BOX_COIN_RANGES.RARE_FALLBACK[1]
  );
  const mid = coinAmountForTier("COMMON", 15);
  assert.ok(mid > DAILY_BOX_COIN_RANGES.COMMON[0]);
  assert.ok(mid < DAILY_BOX_COIN_RANGES.COMMON[1]);
});

test("coinAmountForTier always pays a multiple of 5", () => {
  for (const tier of ["COMMON", "UNCOMMON", "RARE_FALLBACK"]) {
    for (let streak = 1; streak <= DAILY_BOX_STREAK_CAP; streak++) {
      const amount = coinAmountForTier(tier, streak);
      assert.equal(amount % 5, 0, `${tier} @ streak ${streak} = ${amount}`);
    }
  }
});

test("coinAmountForTier returns 0 for unknown tier", () => {
  assert.equal(coinAmountForTier("NOPE", 5), 0);
});

test("pickAccessory returns null on empty pool", () => {
  assert.equal(pickAccessory([], 5), null);
  assert.equal(pickAccessory(null, 5), null);
});

test("pickAccessory always returns an item from the pool", () => {
  const pool = [
    { id: "a", priceCoins: 100 },
    { id: "b", priceCoins: 500 },
    { id: "c", priceCoins: 2000 },
  ];
  for (let i = 0; i < 200; i++) {
    const picked = pickAccessory(pool, 10);
    assert.ok(pool.includes(picked));
  }
});

test("longer streak biases accessory pick toward pricier items", () => {
  const pool = [
    { id: "cheap", priceCoins: 100 },
    { id: "pricey", priceCoins: 2000 },
  ];
  let priceyAtOne = 0;
  let priceyAtCap = 0;
  for (let i = 0; i < 2000; i++) {
    if (pickAccessory(pool, 1).id === "pricey") priceyAtOne++;
    if (pickAccessory(pool, DAILY_BOX_STREAK_CAP).id === "pricey") priceyAtCap++;
  }
  // Pricier item is always favored, but the bias must sharpen with streak.
  assert.ok(
    priceyAtCap > priceyAtOne,
    `pricey at cap (${priceyAtCap}) should exceed pricey at day 1 (${priceyAtOne})`
  );
});
