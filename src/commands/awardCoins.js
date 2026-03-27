const { prisma } = require("../db");

/**
 * Award coins to a user. Idempotent — won't double-award for the same
 * reason + refId combination.
 *
 * @param {object} params
 * @param {string} params.userId
 * @param {number} params.amount - positive to award, negative to deduct
 * @param {string} params.reason - "challenge_win", "daily_goal_1x", "daily_goal_2x", "purchase"
 * @param {string} [params.refId] - dedup key (instanceId, date string, etc.)
 * @returns {Promise<{awarded: boolean, coins: number}>}
 */
async function awardCoins({ userId, amount, reason, refId }) {
  // Idempotency check: if refId is provided, skip if already awarded
  if (refId) {
    const existing = await prisma.coinTransaction.findFirst({
      where: { userId, reason, refId },
    });
    if (existing) {
      const user = await prisma.user.findUnique({ where: { id: userId } });
      return { awarded: false, coins: user?.coins ?? 0 };
    }
  }

  // Atomically create transaction record and update balance
  const [, user] = await prisma.$transaction([
    prisma.coinTransaction.create({
      data: { userId, amount, reason, refId },
    }),
    prisma.user.update({
      where: { id: userId },
      data: { coins: { increment: amount } },
    }),
  ]);

  return { awarded: true, coins: user.coins };
}

module.exports = { awardCoins };
