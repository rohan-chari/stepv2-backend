const { prisma } = require("../db");
const { EXTRA_SPIN_REWARD_KIND } = require("../config/adRewards");

const LOCAL_DATE_RE = /^\d{4}-\d{2}-\d{2}$/;

// Mint an AdRewardGrant from a *verified* AdMob SSV callback (the route owns
// signature verification; this command owns the ledger). Idempotent on
// transactionId — Google retries callbacks, and a replayed/forwarded callback
// must never mint twice. Mirrors grantReferralReward's insert-ledger-first
// pattern; the grant is later consumed by claimExtraDailyRewardBox.
function buildGrantAdReward(dependencies = {}) {
  const db = dependencies.prisma || prisma;

  return async function grantAdReward({
    userId,
    transactionId,
    adUnit = null,
    customData = null,
    rewardKind = EXTRA_SPIN_REWARD_KIND,
    serverDate,
  }) {
    if (!userId || !transactionId) {
      return { granted: false, reason: "invalid" };
    }

    // SSV's user_id comes from the client's ServerSideVerificationOptions, so
    // an attacker-controlled value is possible — it can only ever point a
    // grant at an existing account, and only that account can redeem it.
    const user = await db.user.findUnique({ where: { id: userId } });
    if (!user) return { granted: false, reason: "unknown_user" };

    // custom_data carries the watcher's local date (matches the localDate the
    // claim will send). Anything else falls back to the server's date.
    const grantedDate =
      typeof customData === "string" && LOCAL_DATE_RE.test(customData)
        ? customData
        : serverDate;

    try {
      await db.adRewardGrant.create({
        data: { userId, transactionId, adUnit, rewardKind, grantedDate },
      });
    } catch (error) {
      if (error && error.code === "P2002") {
        return { granted: false, reason: "duplicate" };
      }
      throw error;
    }
    return { granted: true };
  };
}

const grantAdReward = buildGrantAdReward();

module.exports = { buildGrantAdReward, grantAdReward };
