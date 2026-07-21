const assert = require("node:assert/strict");
const test = require("node:test");

const {
  buildGetAdCoinRewardStatus,
} = require("../../src/modules/economy/queries/getAdCoinRewardStatus");
const {
  AD_COIN_REWARD_AMOUNT,
  AD_COIN_REWARD_DAILY_CAP,
} = require("../../src/modules/economy/adRewards");

function makePrismaMock(grants = []) {
  return {
    adRewardGrant: {
      async findMany() {
        return grants;
      },
    },
  };
}

const consumed = { consumedAt: new Date("2026-07-15T12:00:00Z") };
const unconsumed = { consumedAt: null };

test("getAdCoinRewardStatus — reports the cap so the client need not hardcode it", async () => {
  const query = buildGetAdCoinRewardStatus({ prisma: makePrismaMock([]) });
  const result = await query({ userId: "u1", localDate: "2026-07-15" });

  assert.equal(result.dailyCap, AD_COIN_REWARD_DAILY_CAP);
  assert.equal(result.coinAmount, AD_COIN_REWARD_AMOUNT);
  assert.equal(result.remainingToday, AD_COIN_REWARD_DAILY_CAP);
  assert.equal(result.available, true);
  assert.equal(result.pendingGrant, false);
});

test("getAdCoinRewardStatus — remainingToday counts down against the cap", async () => {
  const query = buildGetAdCoinRewardStatus({
    prisma: makePrismaMock([consumed]),
  });
  const result = await query({ userId: "u1", localDate: "2026-07-15" });

  assert.equal(result.dailyCap, AD_COIN_REWARD_DAILY_CAP);
  assert.equal(result.remainingToday, AD_COIN_REWARD_DAILY_CAP - 1);
  assert.equal(result.available, true);
});

test("getAdCoinRewardStatus — an unconsumed grant is claimable without a new ad", async () => {
  const query = buildGetAdCoinRewardStatus({
    prisma: makePrismaMock([consumed, unconsumed]),
  });
  const result = await query({ userId: "u1", localDate: "2026-07-15" });

  assert.equal(result.pendingGrant, true);
});

test("getAdCoinRewardStatus — exhausted day floors at zero and closes the offer", async () => {
  const query = buildGetAdCoinRewardStatus({
    prisma: makePrismaMock(
      Array.from({ length: AD_COIN_REWARD_DAILY_CAP + 2 }, () => consumed)
    ),
  });
  const result = await query({ userId: "u1", localDate: "2026-07-15" });

  assert.equal(result.remainingToday, 0);
  assert.equal(result.available, false);
  // Cap reached: an unconsumed grant must not resurrect the offer.
  assert.equal(result.pendingGrant, false);
});
