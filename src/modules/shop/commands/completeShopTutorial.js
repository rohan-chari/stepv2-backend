const { prisma: defaultPrisma } = require("../../../db");

function buildCompleteShopTutorial(dependencies = {}) {
  const prisma = dependencies.prisma || defaultPrisma;
  const now = dependencies.now || (() => new Date());

  return async function completeShopTutorial({ userId }) {
    const completedAt = now();
    await prisma.user.updateMany({
      where: { id: userId, shopTutorialCompletedAt: null },
      data: { shopTutorialCompletedAt: completedAt },
    });
    const user = await prisma.user.findUnique({
      where: { id: userId },
      select: { shopTutorialCompletedAt: true },
    });
    try {
      await require("../../users/services/authMeCache").invalidateSafe(userId);
    } catch {}
    return {
      tutorialKey: "shop_v1",
      completedAt: user.shopTutorialCompletedAt,
    };
  };
}

const completeShopTutorial = buildCompleteShopTutorial();

module.exports = { buildCompleteShopTutorial, completeShopTutorial };
