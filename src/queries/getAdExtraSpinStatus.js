const { prisma } = require("../db");
const { EXTRA_SPIN_REWARD_KIND } = require("../config/adRewards");

// Additive status block for the rewarded-ad extra daily spin (only attached
// for clients declaring `ads` in X-Client-Features — see routes/dailyReward).
//   available    — free box claimed today and the extra spin not yet used;
//                  the client may show the "watch an ad" button.
//   pendingGrant — a verified, unconsumed ad watch exists for today; the
//                  client can claim directly without showing another ad.
//   used         — the extra spin was already redeemed today.
function buildGetAdExtraSpinStatus(dependencies = {}) {
  const db = dependencies.prisma || prisma;

  return async function getAdExtraSpinStatus({ userId, localDate }) {
    const user = await db.user.findUnique({
      where: { id: userId },
      select: { lastDailyClaimDate: true },
    });
    if (!user) return { available: false, pendingGrant: false, used: false };

    const grants = await db.adRewardGrant.findMany({
      where: {
        userId,
        rewardKind: EXTRA_SPIN_REWARD_KIND,
        grantedDate: localDate,
      },
      select: { consumedAt: true },
    });
    const used = grants.some((g) => g.consumedAt != null);
    const pendingGrant = grants.some((g) => g.consumedAt == null);
    return {
      available: user.lastDailyClaimDate === localDate && !used,
      pendingGrant,
      used,
    };
  };
}

const getAdExtraSpinStatus = buildGetAdExtraSpinStatus();

module.exports = { buildGetAdExtraSpinStatus, getAdExtraSpinStatus };
