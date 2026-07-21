const { deductCoinsAtomic } = require("./deductCoinsAtomic");
const { prisma } = require("../../db");

// Shared buy-in economy (audit §4 / Phase 5): the reserve/refund/payout pattern
// races and tournaments both use. Every function delegates to the idempotent
// awardCoins ledger contract — dedup by (userId, reason, refId), zero amount is
// a no-op — with the per-domain reason strings and refId templates supplied by
// the thin wrappers in services/raceBuyIns.js and services/tournamentBuyIns.js.
// All calls run on the global client (never inside a caller's transaction),
// matching how both domains have always written buy-in ledger rows.

// Fast-fail affordability pre-check. NOT the concurrency guard — that is the
// atomic hold below — but it fails cheap before any rows are written and its
// error/timing is part of each command's contract.
async function ensureUserCanAfford({
  userModel,
  userId,
  amount,
  ErrorClass,
  // Optional machine-readable code (INSUFFICIENT_COINS). Additive: existing
  // callers that omit it get the same code-less error as before.
  code,
}) {
  if (!amount) return;

  const user = await userModel.findById(userId);
  if (!user || user.coins < amount) {
    throw new ErrorClass(
      "You do not have enough coins for this buy-in",
      400,
      code
    );
  }
}

// Balance-guarded buy-in hold. Same external contract as awardCoins for a
// negative amount — idempotent by (userId, reason, refId), returns
// { awarded, coins }, concurrent duplicate refId resolves to a no-op — but the
// debit itself refuses to overdraw, closing the race between the
// ensureUserCanAfford pre-check and the hold (the pre-check stays as a
// fast-fail; this is the enforcement). Built per call site so insufficient
// balance throws that site's exact error class/message/code, identical to what
// ensureUserCanAfford throws today.
function buildAtomicHoldFn({ ErrorClass, code }) {
  return async function holdCoinsAtomic({ userId, amount, reason, refId }) {
    const existing = await prisma.coinTransaction.findFirst({
      where: { userId, reason, refId },
    });
    if (existing) {
      const user = await prisma.user.findUnique({ where: { id: userId } });
      return { awarded: false, coins: user?.coins ?? 0 };
    }

    try {
      const { coins } = await deductCoinsAtomic({
        userId,
        amount: -amount,
        reason,
        refId,
        insufficientError: new ErrorClass(
          "You do not have enough coins for this buy-in",
          400,
          code
        ),
      });
      return { awarded: true, coins };
    } catch (error) {
      // Concurrent duplicate hold racing the ledger's (userId, reason, refId)
      // unique index: the loser's debit rolled back — replay as a no-op,
      // mirroring awardCoins' P2002 fallback.
      if (error?.code === "P2002") {
        const user = await prisma.user.findUnique({ where: { id: userId } });
        return { awarded: false, coins: user?.coins ?? 0 };
      }
      throw error;
    }
  };
}

// Reserve (hold): debits `amount` via the caller-supplied ledger fn (the
// guarded holdCoinsFn in production, an awardCoins fake in unit tests).
async function holdBuyIn({ awardCoinsFn, userId, amount, reason, refId }) {
  if (!amount) return null;

  return awardCoinsFn({
    userId,
    amount: -amount,
    reason,
    refId,
  });
}

// Refunds, payouts, and minted prizes are all positive idempotent credits —
// deliberately unguarded (a credit cannot overdraw).
async function creditBuyIn({ awardCoinsFn, userId, amount, reason, refId }) {
  if (!amount) return null;

  return awardCoinsFn({
    userId,
    amount,
    reason,
    refId,
  });
}

module.exports = {
  buildAtomicHoldFn,
  creditBuyIn,
  ensureUserCanAfford,
  holdBuyIn,
};
