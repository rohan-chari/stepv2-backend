const { prisma } = require("../db");
const {
  COIN_REWARD_KIND,
  AD_COIN_REWARD_AMOUNT,
  AD_COIN_REWARD_DAILY_CAP,
} = require("../config/adRewards");

// Additive status block for watch-ad-for-coins (only attached for clients
// declaring `ads` in X-Client-Features — see routes/dailyReward).
//   available      — watches remain today; the hub may show the button.
//   pendingGrant   — a verified, unconsumed ad watch exists for today; the
//                    client can claim directly without showing another ad.
//   remainingToday — watches left before the daily cap.
//   coinAmount     — coins per watch (client renders, server enforces).
function buildGetAdCoinRewardStatus(dependencies = {}) {
  const db = dependencies.prisma || prisma;

  return async function getAdCoinRewardStatus({ userId, localDate }) {
    const grants = await db.adRewardGrant.findMany({
      where: {
        userId,
        rewardKind: COIN_REWARD_KIND,
        grantedDate: localDate,
      },
      select: { consumedAt: true },
    });
    const consumed = grants.filter((g) => g.consumedAt != null).length;
    const remainingToday = Math.max(0, AD_COIN_REWARD_DAILY_CAP - consumed);
    return {
      available: remainingToday > 0,
      pendingGrant:
        remainingToday > 0 && grants.some((g) => g.consumedAt == null),
      remainingToday,
      coinAmount: AD_COIN_REWARD_AMOUNT,
    };
  };
}

const getAdCoinRewardStatus = buildGetAdCoinRewardStatus();

module.exports = { buildGetAdCoinRewardStatus, getAdCoinRewardStatus };
