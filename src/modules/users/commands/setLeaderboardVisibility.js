const { prisma: defaultPrisma } = require("../../../db");
const { buildLeaderboardEligibilityEpoch } = require("../../../shared/config/leaderboardEligibilityEpoch");

function buildSetLeaderboardVisibility(dependencies = {}) {
  const prisma = dependencies.prisma || defaultPrisma;
  const epoch = dependencies.leaderboardEligibilityEpoch ||
    buildLeaderboardEligibilityEpoch({ prisma });
  const presentation = dependencies.userPresentationCache ||
    require("../../social/services/userPresentationCache");
  const authMe = dependencies.authMeCache || require("../services/authMeCache");

  return async function setLeaderboardVisibility({ userId, hidden }) {
    const user = await prisma.$transaction(async (tx) => {
      const updated = await tx.user.update({
        where: { id: userId },
        data: { hiddenFromLeaderboard: hidden },
      });
      await epoch.advance(tx);
      return updated;
    });
    await Promise.all([
      presentation.invalidate(userId),
      authMe.invalidateSafe(userId),
    ]);
    return user;
  };
}

const setLeaderboardVisibility = buildSetLeaderboardVisibility();
module.exports = { buildSetLeaderboardVisibility, setLeaderboardVisibility };
