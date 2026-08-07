const { prisma } = require("../../db");

// C5 (spec §5 Phase E2, §9's last acceptance box): with awardCoins.js, one of
// the only two `users.coins` writers (pinned by
// test/services/coinSeamStructuralGuard.test.js). Both DELETE the 10s
// `/auth/me` cache so a purchase is visible on the client's very next refresh.
//
// NOTE on the `tx` variant: when a caller runs this inside its own transaction
// the DEL fires just BEFORE that transaction commits, so a `/auth/me` landing in
// that window could re-warm the pre-commit balance. The four purchase commands
// that pass `tx` therefore invalidate AGAIN post-commit; the 10s TTL is the
// backstop for anything else.
async function invalidateAuthMe(userId) {
  try {
    await require("../../modules/users/services/authMeCache").invalidateSafe(userId);
  } catch {
    // A cache DEL must never fail a ledgered coin write.
  }
}

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

  const result = tx ? await run(tx) : await prisma.$transaction(run);
  await invalidateAuthMe(userId);
  return result;
}

module.exports = { deductCoinsAtomic, InsufficientCoinsError };
