const { prisma } = require("../db");
const { awardCoins } = require("./awardCoins");
const {
  DailyRewardError,
  isValidLocalDate,
  withinOneDayOfServer,
} = require("./claimDailyReward");
const {
  COIN_REWARD_KIND,
  AD_COIN_REWARD_AMOUNT,
  AD_COIN_REWARD_DAILY_CAP,
} = require("../config/adRewards");

// Watch-ad-for-coins (Get Coins hub). Consumes an unconsumed coin_reward
// AdRewardGrant for the same localDate (minted only by the AdMob SSV callback
// — the client is never trusted) and mints a flat coin amount, capped per
// local day. Unlike the extra spin this has no dependency on the free daily
// box: the hub offers it any time watches remain. Mirrors
// claimExtraDailyRewardBox's consume-then-mint shape so a crash between the
// two can't double-pay (awardCoins is idempotent on the grant id).
function buildClaimAdCoinReward(dependencies = {}) {
  const db = dependencies.prisma || prisma;
  const awardCoinsFn = dependencies.awardCoins || awardCoins;

  return async function claimAdCoinReward({ userId, localDate }) {
    if (!isValidLocalDate(localDate)) {
      throw new DailyRewardError("Invalid localDate (expected YYYY-MM-DD)", 400);
    }
    if (!withinOneDayOfServer(localDate)) {
      throw new DailyRewardError("localDate is too far from server time", 400);
    }

    const consumedToday = await db.adRewardGrant.count({
      where: {
        userId,
        rewardKind: COIN_REWARD_KIND,
        grantedDate: localDate,
        consumedAt: { not: null },
      },
    });
    if (consumedToday >= AD_COIN_REWARD_DAILY_CAP) {
      const err = new DailyRewardError(
        "Daily ad coin reward cap reached",
        409
      );
      err.code = "DAILY_CAP_REACHED";
      throw err;
    }

    const grant = await db.adRewardGrant.findFirst({
      where: {
        userId,
        rewardKind: COIN_REWARD_KIND,
        grantedDate: localDate,
        consumedAt: null,
      },
      orderBy: { createdAt: "asc" },
      select: { id: true },
    });
    if (!grant) {
      const err = new DailyRewardError(
        "No verified ad reward available yet",
        409
      );
      // The client retries briefly on this code — the SSV callback can lag
      // the on-device earned-reward event by a few seconds.
      err.code = "AD_NOT_VERIFIED";
      throw err;
    }

    // Conditional consume: a concurrent duplicate claim loses here (count 0)
    // before anything mints.
    const consumed = await db.adRewardGrant.updateMany({
      where: { id: grant.id, consumedAt: null },
      data: { consumedAt: new Date() },
    });
    if (!consumed || consumed.count === 0) {
      const err = new DailyRewardError("Reward already claimed", 409);
      err.code = "CLAIM_CONFLICT";
      throw err;
    }

    const result = await awardCoinsFn({
      userId,
      amount: AD_COIN_REWARD_AMOUNT,
      reason: "ad_coin_reward",
      refId: grant.id,
    });

    await db.adRewardGrant.update({
      where: { id: grant.id },
      data: { rewardType: "COINS", coinAmount: AD_COIN_REWARD_AMOUNT },
    });

    return {
      coinAmount: AD_COIN_REWARD_AMOUNT,
      coins: result.coins,
      remainingToday: Math.max(
        0,
        AD_COIN_REWARD_DAILY_CAP - (consumedToday + 1)
      ),
    };
  };
}

const claimAdCoinReward = buildClaimAdCoinReward();

module.exports = { buildClaimAdCoinReward, claimAdCoinReward };
