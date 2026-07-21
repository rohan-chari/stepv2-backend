const { prisma } = require("../../db");

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
 * This is the canonical debit path (audit Phase 3): every guarded deduction —
 * standalone or inside a larger purchase transaction — goes through here so the
 * guard + ledger-row shape can never drift between call sites.
 *
 * - amount must be a non-negative integer (a deduction, not a credit)
 * - amount=0 is a no-op
 * - on insufficient coins, throws `insufficientError` if provided (call sites
 *   preserve their domain error class, e.g. PowerupPurchaseError — routes map
 *   by error name), else InsufficientCoinsError; creates no transaction record
 * - pass `tx` (a Prisma transaction client) to run inside an existing
 *   transaction — e.g. a purchase that must debit atomically with its
 *   inventory grant. Without `tx`, runs in its own transaction.
 *
 * @returns {Promise<{coins: number}>} the user's new balance
 */
async function deductCoinsAtomic({ userId, amount, reason, refId, tx, insufficientError }) {
  if (!Number.isInteger(amount) || amount < 0) {
    throw new Error("amount must be a non-negative integer");
  }
  if (amount === 0) {
    const user = await (tx ?? prisma).user.findUnique({ where: { id: userId } });
    return { coins: user?.coins ?? 0 };
  }

  const run = async (client) => {
    const updated = await client.user.updateMany({
      where: { id: userId, coins: { gte: amount } },
      data: { coins: { decrement: amount } },
    });

    if (updated.count === 0) {
      throw insufficientError || new InsufficientCoinsError();
    }

    await client.coinTransaction.create({
      data: { userId, amount: -amount, reason, refId },
    });

    const user = await client.user.findUnique({ where: { id: userId } });
    return { coins: user.coins };
  };

  return tx ? run(tx) : prisma.$transaction(run);
}

module.exports = { deductCoinsAtomic, InsufficientCoinsError };
