const { prisma } = require("../../../db");

// Authed dashboard feed for GET /referrals/me. Lists the caller's signed-up
// referees with a coarse stage badge plus the coins they've earned. Only
// referees who actually signed up appear (a Referral row is written at signup,
// M1) — link taps that never convert aren't tracked in the MVP.
//
// stage: "joined"    — signed up, hasn't completed a qualifying race yet
//        "completed" — finished their first qualifying race (reward fired)
function buildGetReferralStatus(dependencies = {}) {
  const db = dependencies.prisma || prisma;

  return async function getReferralStatus({ userId }) {
    const referrals = await db.referral.findMany({
      where: { referrerId: userId },
      orderBy: { createdAt: "desc" },
      include: {
        referee: { select: { displayName: true, profilePhotoUrl: true } },
      },
    });

    // Coins earned as a referrer (the REFEREE-role grants belong to the friend).
    const earned = await db.referralRewardGrant.aggregate({
      where: { userId, role: "REFERRER" },
      _sum: { coins: true },
    });

    const friends = referrals.map((r) => ({
      displayName: r.referee?.displayName ?? null,
      profilePhotoUrl: r.referee?.profilePhotoUrl ?? null,
      stage:
        r.status === "REWARDED" || r.status === "QUALIFIED"
          ? "completed"
          : "joined",
      joinedAt: r.createdAt,
    }));

    return {
      referredCount: friends.length,
      completedCount: friends.filter((f) => f.stage === "completed").length,
      coinsEarned: earned._sum.coins || 0,
      friends,
    };
  };
}

const getReferralStatus = buildGetReferralStatus();

module.exports = { buildGetReferralStatus, getReferralStatus };
