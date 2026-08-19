const assert = require("node:assert/strict");
const test = require("node:test");
const {
  cohortBucket,
  boundedRolloutPercent,
  canonicalUuid,
  safeStructuredEvent,
  HARD_MAX_RACE_PAYOUT_DOUBLE_BONUS_COINS,
  boundedRacePayoutDoubleMaxBonus,
  computeRacePayoutDoubleBonus,
  normalizedRacePayoutDoubleAmounts,
} = require("../../src/modules/races/services/racePayoutDoublePolicy");

test("race payout double cohort hashing pins the unsigned-big-endian vectors", () => {
  assert.equal(cohortBucket("0".repeat(64)), 63);
  assert.equal(cohortBucket("a".repeat(64)), 91);
  assert.equal(cohortBucket("0123456789abcdef".repeat(4)), 16);
  assert.equal(cohortBucket("f".repeat(64)), 88);
});

test("race payout double rollout accepts only integer 0..100", () => {
  assert.equal(boundedRolloutPercent(0), 0);
  assert.equal(boundedRolloutPercent(10), 10);
  assert.equal(boundedRolloutPercent(100), 100);
  for (const bad of [-1, 101, 10.5, "10", null, undefined]) {
    assert.equal(boundedRolloutPercent(bad), 0);
  }
});

test("race payout double bonus has a non-configurable 100-coin hard ceiling", () => {
  assert.equal(HARD_MAX_RACE_PAYOUT_DOUBLE_BONUS_COINS, 100);
  assert.equal(boundedRacePayoutDoubleMaxBonus(40), 40);
  assert.equal(boundedRacePayoutDoubleMaxBonus(100), 100);
  assert.equal(boundedRacePayoutDoubleMaxBonus(500), 100);
  assert.equal(boundedRacePayoutDoubleMaxBonus("100"), 100);

  assert.equal(computeRacePayoutDoubleBonus({
    baseCoins: 853,
    configuredMaxBonusCoins: 500,
    rolling24hRemaining: 500,
  }), 100);
  assert.equal(computeRacePayoutDoubleBonus({
    baseCoins: 80,
    configuredMaxBonusCoins: 100,
    rolling24hRemaining: 100,
  }), 80);
  assert.equal(computeRacePayoutDoubleBonus({
    baseCoins: 853,
    configuredMaxBonusCoins: 100,
    rolling24hRemaining: 20,
  }), 20);
  assert.equal(computeRacePayoutDoubleBonus({
    baseCoins: 853,
    configuredMaxBonusCoins: 100,
    rolling24hRemaining: 0,
  }), 0);

  assert.deepEqual(normalizedRacePayoutDoubleAmounts({
    baseCoins: 500,
    bonusCoins: 500,
    maxBonusCoins: 500,
    rolling24hRemainingBeforeClaim: 500,
  }, {
    configuredMaxBonusCoins: 40,
    rolling24hRemaining: 20,
  }), {
    baseCoins: 500,
    bonusCoins: 20,
    maxBonusCoins: 40,
    rolling24hRemainingBeforeClaim: 20,
  });
});

test("race payout double uses canonical RFC-4122 UUIDs", () => {
  assert.equal(canonicalUuid("d05cb2a4-16b7-463f-977d-58231987a0ac"), true);
  assert.equal(canonicalUuid("D05CB2A4-16B7-463F-977D-58231987A0AC"), false);
  assert.equal(canonicalUuid("not-a-uuid"), false);
});

test("structured-event logging is synchronous-safe and best effort", () => {
  assert.doesNotThrow(() => safeStructuredEvent({ info() { throw new Error("down"); } }, {
    event: "race_payout_double_endpoint_metric",
    operation: "claim",
    code: "AD_NOT_VERIFIED",
  }));
});

test("structured-event logging absorbs a rejected-Promise logger without awaiting it", async () => {
  assert.doesNotThrow(() => safeStructuredEvent({
    info() { return Promise.reject(new Error("async logger down")); },
  }, {
    event: "race_payout_double_endpoint_metric",
    operation: "prepare",
    code: "OFFER_CHANGED",
  }));
  await new Promise((resolve) => setImmediate(resolve));
});
