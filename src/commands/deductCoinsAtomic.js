const { prisma } = require("../db");

class InsufficientCoinsError extends Error {
  constructor(message = "Insufficient coins") {
    super(message);
    this.name = "InsufficientCoinsError";
    this.statusCode = 400;
  }
}

/**
 * Atomically deducts coins from a user, guarded by a balance precondition.
 * Uses prisma.user.updateMany with a `where: { coins: { gte: amount } }` filter
 * so that two concurrent requests cannot overdraw the wallet.
 *
 * - amount must be a non-negative integer (a deduction, not a credit)
 * - amount=0 is a no-op
 * - on insufficient coins, throws InsufficientCoinsError and creates no transaction record
 *
 * @returns {Promise<{coins: number}>} the user's new balance
 */
async function deductCoinsAtomic({ userId, amount, reason, refId }) {
  if (!Number.isInteger(amount) || amount < 0) {
    throw new Error("amount must be a non-negative integer");
  }
  if (amount === 0) {
    const user = await prisma.user.findUnique({ where: { id: userId } });
    return { coins: user?.coins ?? 0 };
  }

  return prisma.$transaction(async (tx) => {
    const updated = await tx.user.updateMany({
      where: { id: userId, coins: { gte: amount } },
      data: { coins: { decrement: amount } },
    });

    if (updated.count === 0) {
      throw new InsufficientCoinsError();
    }

    await tx.coinTransaction.create({
      data: { userId, amount: -amount, reason, refId },
    });

    const user = await tx.user.findUnique({ where: { id: userId } });
    return { coins: user.coins };
  });
}

module.exports = { deductCoinsAtomic, InsufficientCoinsError };
