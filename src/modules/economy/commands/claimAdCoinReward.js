const { prisma } = require("../../../db");
const { awardCoins } = require("../../../shared/economy/awardCoins");
const {
  DailyRewardError,
  isValidLocalDate,
  withinOneDayOfServer,
} = require("./claimDailyReward");
const {
  COIN_REWARD_KIND,
  AD_COIN_REWARD_AMOUNT,
  AD_COIN_REWARD_DAILY_CAP,
  randomAdCoinRewardAmount,
} = require("../adRewards");

// Watch-ad-for-coins (Get Coins hub). Consumes an unconsumed coin_reward
// AdRewardGrant for the same localDate (minted only by the AdMob SSV callback
// — the client is never trusted) and mints a random coin amount, capped per
// local day. Unlike the extra spin this has no dependency on the free daily
// box: the hub offers it any time watches remain. Mirrors
// claimExtraDailyRewardBox's consume-then-mint shape so a crash between the
// two can't double-pay (awardCoins is idempotent on the grant id).
function buildClaimAdCoinReward(dependencies = {}) {
  const db = dependencies.prisma || prisma;
  const awardCoinsFn = dependencies.awardCoins || awardCoins;
  const random = dependencies.random || Math.random;

  return async function claimAdCoinReward({ userId, localDate }) {
    if (!isValidLocalDate(localDate)) {
      throw new DailyRewardError("Invalid localDate (expected YYYY-MM-DD)", 400);
    }
    if (!withinOneDayOfServer(localDate)) {
      throw new DailyRewardError("localDate is too far from server time", 400);
    }

    return db.$transaction(async (tx) => {
      const consumedToday = await tx.adRewardGrant.count({
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

      const grant = await tx.adRewardGrant.findFirst({
        where: {
          userId,
          rewardKind: COIN_REWARD_KIND,
          grantedDate: localDate,
          consumedAt: null,
        },
        orderBy: { createdAt: "asc" },
        select: { id: true, coinAmount: true },
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

      const coinAmount = grant.coinAmount ?? randomAdCoinRewardAmount(random);
      const result = await awardCoinsFn({
        userId,
        amount: coinAmount,
        reason: "ad_coin_reward",
        refId: grant.id,
        tx,
      });

      await tx.adRewardGrant.update({
        where: { id: grant.id },
        data: { consumedAt: new Date(), rewardType: "COINS", coinAmount },
      });

      return {
        coinAmount,
        coins: result.coins,
        remainingToday: Math.max(
          0,
          AD_COIN_REWARD_DAILY_CAP - (consumedToday + 1)
        ),
      };
    }, { isolationLevel: "Serializable" });
  };
}

const claimAdCoinReward = buildClaimAdCoinReward();

module.exports = { buildClaimAdCoinReward, claimAdCoinReward };
