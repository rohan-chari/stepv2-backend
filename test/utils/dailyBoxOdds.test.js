const assert = require("node:assert/strict");
const test = require("node:test");

const {
  DAILY_BOX_STREAK_CAP,
  DAILY_BOX_ODDS_TABLE,
  DAILY_BOX_COIN_RANGES,
  streakProgress,
  interpolateDailyBoxOdds,
  dailyBoxOddsForPool,
  rollDailyBoxRarity,
  rollRarePrizeKind,
  coinAmountForTier,
  pickAccessory,
  pickPowerup,
} = require("../../src/modules/economy/dailyBoxOdds");

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

test("dailyBoxOddsForPool passes interpolated odds through for a non-empty pool", () => {
  for (const streak of [1, 10, DAILY_BOX_STREAK_CAP]) {
    assert.deepEqual(
      dailyBoxOddsForPool(streak, 3),
      interpolateDailyBoxOdds(streak)
    );
  }
});

test("dailyBoxOddsForPool folds RARE into UNCOMMON on an empty pool", () => {
  for (const streak of [1, 10, DAILY_BOX_STREAK_CAP, 60]) {
    const [common, uncommon, rare] = dailyBoxOddsForPool(streak, 0);
    assert.equal(rare, 0, `streak ${streak} should serve RARE 0`);
    // Exact sum (not just within epsilon): the shipped client draws a reel
    // tile whenever its cumulative roll passes COMMON + UNCOMMON, so any
    // float sliver below 1 would still let the "???" mystery tile through.
    assert.equal(common + uncommon, 1, `streak ${streak} must sum to exactly 1`);
  }
});

test("rollDailyBoxRarity never rolls RARE on an empty pool", () => {
  for (const streak of [1, DAILY_BOX_STREAK_CAP]) {
    for (const roll of [0, 0.5, 0.95, 0.999999, 1 - Number.EPSILON]) {
      const rarity = rollDailyBoxRarity(streak, () => roll, 0);
      assert.notEqual(rarity, "RARE", `streak ${streak} roll ${roll}`);
    }
  }
});

// ── Powerup prize sub-roll (spinPowerups feature) ──────────────────────────

test("dailyBoxOddsForPool: powerup pool keeps RARE alive when accessories are empty", () => {
  for (const streak of [1, 10, DAILY_BOX_STREAK_CAP]) {
    // Old-client shape (no powerup arg) still folds RARE to 0 on an empty
    // accessory pool — byte-for-byte the historical behavior.
    const [, , legacyRare] = dailyBoxOddsForPool(streak, 0);
    assert.equal(legacyRare, 0, `legacy streak ${streak} folds RARE to 0`);

    // With powerups available, RARE stays at its interpolated value.
    const withPowerups = dailyBoxOddsForPool(streak, 0, 3);
    assert.deepEqual(withPowerups, interpolateDailyBoxOdds(streak));
  }
});

test("dailyBoxOddsForPool: both pools empty still folds RARE to 0", () => {
  const [common, uncommon, rare] = dailyBoxOddsForPool(15, 0, 0);
  assert.equal(rare, 0);
  assert.equal(common + uncommon, 1);
});

test("rollDailyBoxRarity: RARE reachable via powerups when accessory pool empty", () => {
  assert.equal(rollDailyBoxRarity(1, () => 0.96, 0, 3), "RARE");
  // Without a powerup pool the same roll can't be RARE (folded).
  assert.notEqual(rollDailyBoxRarity(1, () => 0.96, 0, 0), "RARE");
});

test("rollRarePrizeKind: 50/50 when both pools are stocked", () => {
  assert.equal(rollRarePrizeKind(3, 3, () => 0.0), "ACCESSORY");
  assert.equal(rollRarePrizeKind(3, 3, () => 0.49), "ACCESSORY");
  assert.equal(rollRarePrizeKind(3, 3, () => 0.5), "POWERUP");
  assert.equal(rollRarePrizeKind(3, 3, () => 0.99), "POWERUP");
});

test("rollRarePrizeKind: 100% one kind when only one pool is stocked", () => {
  // Accessory pool empty → always powerup (fixes dead-RARE for owns-everything).
  for (const roll of [0, 0.5, 0.99]) {
    assert.equal(rollRarePrizeKind(0, 5, () => roll), "POWERUP");
  }
  // Powerup pool empty → always accessory (legacy behavior preserved).
  for (const roll of [0, 0.5, 0.99]) {
    assert.equal(rollRarePrizeKind(5, 0, () => roll), "ACCESSORY");
  }
});

test("rollRarePrizeKind: null when neither pool has stock", () => {
  assert.equal(rollRarePrizeKind(0, 0, () => 0.5), null);
});

test("pickPowerup returns null on empty pool, else an item from the pool", () => {
  assert.equal(pickPowerup([], 5), null);
  assert.equal(pickPowerup(null, 5), null);
  const pool = [
    { powerupType: "IMPOSTER", priceCoins: 75 },
    { powerupType: "RAINSTORM", priceCoins: 75 },
    { powerupType: "SIGNAL_JAMMER", priceCoins: 75 },
  ];
  for (let i = 0; i < 200; i++) {
    assert.ok(pool.includes(pickPowerup(pool, 10)));
  }
});

test("rollDailyBoxRarity keeps RARE reachable when the pool has items", () => {
  assert.equal(rollDailyBoxRarity(1, () => 0.96, 5), "RARE");
  // Omitted poolSize (legacy callers/tests) behaves as a non-empty pool.
  assert.equal(rollDailyBoxRarity(1, () => 0.96), "RARE");
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

// INVERTED (accessoryWeightMode: "inverse"). This test previously asserted that
// a longer streak made PRICIER accessories MORE likely — weight was price^(1+t),
// so at streak cap a 1500-coin cosmetic was ~36x likelier than a 250-coin one.
// That made the prestige tier the most common daily-box drop, inverting the
// pricing philosophy (prestige = 4-8 weeks of play). The old behaviour is still
// reachable via accessoryWeightMode: "legacy" for rollback only.
test("longer streak biases accessory pick AWAY from pricier items", () => {
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
  // Prestige items must get RARER as the streak grows, not commoner.
  assert.ok(
    priceyAtCap < priceyAtOne,
    `pricey at cap (${priceyAtCap}) should be BELOW pricey at day 1 (${priceyAtOne})`
  );
});
