const { prisma } = require("../../db");
// C5 (spec §5 Phase E2, §9's last acceptance box): this file and
// deductCoinsAtomic.js are the ONLY two `users.coins` writers, pinned by
// test/services/coinSeamStructuralGuard.test.js. `coins` is the single most
// read-back-after-write field in the client (15 wallet-refresh sites), so both
// seams DELETE the 10s `/auth/me` cache. Lazy require: the cache module pulls in
// the Redis wrapper, and this file is required from settlement paths that must
// stay Redis-free at load time.
async function invalidateAuthMe(userId) {
  try {
    await require("../../modules/users/services/authMeCache").invalidateSafe(userId);
  } catch {
    // A cache DEL must never fail a ledgered coin write.
  }
}

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
async function awardCoins({ userId, amount, reason, refId, createdAt, tx = null }) {
  const db = tx || prisma;
  const transactionData = {
    userId,
    amount,
    reason,
    refId,
    ...(createdAt ? { createdAt } : {}),
  };
  if (tx) {
    const inserted = await db.coinTransaction.createMany({
      data: [transactionData],
      skipDuplicates: true,
    });
    if (inserted.count === 0) {
      const user = await db.user.findUnique({ where: { id: userId } });
      return { awarded: false, coins: user?.coins ?? 0 };
    }
    const user = await db.user.update({
      where: { id: userId },
      data: { coins: { increment: amount } },
    });
    await invalidateAuthMe(userId);
    return { awarded: true, coins: user.coins };
  }
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
  try {
    const [, user] = await prisma.$transaction([
      prisma.coinTransaction.create({
        data: transactionData,
      }),
      prisma.user.update({
        where: { id: userId },
        data: { coins: { increment: amount } },
      }),
    ]);

    await invalidateAuthMe(userId);
    return { awarded: true, coins: user.coins };
  } catch (error) {
    // The preflight read is an optimization, not the concurrency boundary. The
    // unique ledger index is authoritative: if two devices claim together, one
    // transaction wins and the other's balance increment is rolled back.
    if (refId && error?.code === "P2002") {
      const user = await prisma.user.findUnique({ where: { id: userId } });
      return { awarded: false, coins: user?.coins ?? 0 };
    }
    throw error;
  }
}

module.exports = { awardCoins };
