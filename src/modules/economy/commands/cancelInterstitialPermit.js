const { prisma: defaultPrisma } = require("../../../db");
const {
  ensureAndLockInterstitialCap,
  cancelOwnedInterstitialPermit,
} = require("../models/interstitialAdState");

function buildCancelInterstitialPermit(dependencies = {}) {
  const db = dependencies.prisma || defaultPrisma;
  return async function cancelInterstitialPermit({ userId, permitId, now }) {
    await db.$transaction(async (tx) => {
      // Serialize cancellation with impression confirmation. Whichever wins
      // the account lock establishes the terminal permit state; a permit can
      // never end up both cancelled and confirmed.
      await ensureAndLockInterstitialCap(tx, userId);
      await cancelOwnedInterstitialPermit(tx, { userId, permitId, now });
    });
    return { cancelled: true };
  };
}

const cancelInterstitialPermit = buildCancelInterstitialPermit();

module.exports = { buildCancelInterstitialPermit, cancelInterstitialPermit };
