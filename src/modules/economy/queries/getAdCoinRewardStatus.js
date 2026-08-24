const { prisma } = require("../../../db");
const {
  COIN_REWARD_KIND,
  AD_COIN_REWARD_AMOUNT,
  AD_COIN_REWARD_MIN,
  AD_COIN_REWARD_MAX,
  AD_COIN_REWARD_DAILY_CAP,
} = require("../adRewards");

// Additive status block for watch-ad-for-coins (only attached for clients
// declaring `ads` in X-Client-Features — see routes/dailyReward).
//   available      — watches remain today; the hub may show the button.
//   pendingGrant   — a verified, unconsumed ad watch exists for today; the
//                    client can claim directly without showing another ad.
//   remainingToday — watches left before the daily cap.
//   coinAmount     — coins per watch (client renders, server enforces).
//   dailyCap       — watches allowed per local day, so the hub's "N of CAP left
//                    today" copy tracks a retuned cap instead of hardcoding it.
//                    Additive: builds before 1.6.1 ignore it and print 3.
function buildGetAdCoinRewardStatus(dependencies = {}) {
  const db = dependencies.prisma || prisma;

  return async function getAdCoinRewardStatus({ userId, localDate }) {
    const grants = await db.adRewardGrant.findMany({
      where: {
        userId,
        rewardKind: COIN_REWARD_KIND,
        grantedDate: localDate,
      },
      select: { consumedAt: true, coinAmount: true },
    });
    const consumed = grants.filter((g) => g.consumedAt != null).length;
    const remainingToday = Math.max(0, AD_COIN_REWARD_DAILY_CAP - consumed);
    const pending = grants.find((g) => g.consumedAt == null);
    return {
      available: remainingToday > 0,
      pendingGrant: remainingToday > 0 && pending != null,
      remainingToday,
      // Before SSV creates a grant there is no per-watch amount yet; expose
      // the lower bound as stable preview copy. Once a grant exists, return
      // its persisted random amount.
      coinAmount: pending?.coinAmount ?? AD_COIN_REWARD_AMOUNT,
      coinRewardMin: AD_COIN_REWARD_MIN,
      coinRewardMax: AD_COIN_REWARD_MAX,
      dailyCap: AD_COIN_REWARD_DAILY_CAP,
    };
  };
}

const getAdCoinRewardStatus = buildGetAdCoinRewardStatus();

module.exports = { buildGetAdCoinRewardStatus, getAdCoinRewardStatus };
