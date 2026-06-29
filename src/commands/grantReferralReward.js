const { prisma } = require("../db");
const { awardCoins } = require("./awardCoins");
const {
  REFERRER_REWARD_COINS,
  REFEREE_REWARD_COINS,
  QUALIFY_WINDOW_DAYS,
} = require("../config/referralRewards");

// Referral reward fire (M2). Called once per race from completeRace.js AFTER
// settlement, for the referee's FIRST *qualifying* completed race. Pays the
// referrer and (double-sided) the referee. Best-effort and NEVER throws —
// settlement correctness is the priority; a referral failure must not break
// payouts. Mirrors joinRaceCore.js maybeGrantOnboardingBoxes (insert-ledger-row-
// first idempotency) and emits REFERRAL_REWARDED events AFTER the grant commits.
function buildGrantReferralRewardsForRace(dependencies = {}) {
  const db = dependencies.prisma || prisma;
  const awardCoinsFn = dependencies.awardCoins || awardCoins;
  const now = dependencies.now || (() => new Date());

  // Insert the ledger row FIRST, then award coins. The
  // @@unique([refereeSubHash, role]) collides on any repeat (incl. a prior grant
  // from a deleted+reinstalled account, since the row outlives the account) and
  // aborts before a coin mints — exactly-once per human per role, forever.
  // Returns true only when THIS call minted the grant (so we emit once).
  async function grantRole({ referralId, userId, role, refereeSubHash, coins }) {
    try {
      await db.referralRewardGrant.create({
        data: { referralId, userId, role, refereeSubHash, coins },
      });
    } catch (error) {
      if (error && error.code === "P2002") return false; // already rewarded
      throw error;
    }
    // awardCoins runs in its own transaction and dedups on (reason, refId), so a
    // retry after a crash between the two never double-grants.
    await awardCoinsFn({
      userId,
      amount: coins,
      reason: "referral_reward",
      refId: `referral:${referralId}:${role}`,
    });
    return true;
  }

  // Process one PENDING attribution. Returns REFERRAL_REWARDED payloads to emit.
  async function grantForReferral(referral) {
    const events = [];

    // Attribution-window check: a stale PENDING attribution never pays out.
    const ageMs = now().getTime() - new Date(referral.createdAt).getTime();
    if (ageMs > QUALIFY_WINDOW_DAYS * 24 * 60 * 60 * 1000) {
      await db.referral.update({
        where: { id: referral.id },
        data: { status: "EXPIRED" },
      });
      return events;
    }

    const { refereeSubHash } = referral;

    // Referrer side — skip if they deleted their account (referrerId SetNull'd);
    // the referee is still paid below.
    if (referral.referrerId) {
      const paid = await grantRole({
        referralId: referral.id,
        userId: referral.referrerId,
        role: "REFERRER",
        refereeSubHash,
        coins: REFERRER_REWARD_COINS,
      });
      if (paid) {
        events.push({
          referrerId: referral.referrerId,
          refereeId: referral.refereeId,
          coins: REFERRER_REWARD_COINS,
        });
      }
    }

    // Referee side (double-sided) — independent of the referrer grant, so a
    // P2002 on one role never blocks the other (§5C.6).
    await grantRole({
      referralId: referral.id,
      userId: referral.refereeId,
      role: "REFEREE",
      refereeSubHash,
      coins: REFEREE_REWARD_COINS,
    });

    await db.referral.update({
      where: { id: referral.id },
      data: { status: "REWARDED" },
    });

    return events;
  }

  return async function grantReferralRewardsForRace({ race }) {
    const events = [];
    try {
      if (!race || !Array.isArray(race.participants)) return events;

      // Qualifying-race gate (anti-farm, §5C.2 / §8.1): a system-SEEDED race
      // (the referee can't spin one up) OR a genuine multi-person contest — at
      // least 2 distinct ACCEPTED finishers who actually accrued steps. This
      // closes the solo self-created throwaway-race vector that totalSteps>0
      // alone leaves open.
      const realParticipants = race.participants.filter(
        (p) => p.status === "ACCEPTED" && (p.totalSteps || 0) > 0
      );
      const isQualifyingRace =
        race.seedId != null || realParticipants.length >= 2;
      if (!isQualifyingRace) return events;

      // Settled finishers who actually walked (not no-shows).
      const finishers = race.participants.filter(
        (p) =>
          p.status === "ACCEPTED" &&
          p.placement != null &&
          (p.totalSteps || 0) > 0
      );
      if (finishers.length === 0) return events;

      // One batch query for PENDING attributions among the finishers (cheap even
      // for large seeded fields), then grant only for the actually-referred ones.
      const referrals = await db.referral.findMany({
        where: {
          refereeId: { in: finishers.map((f) => f.userId) },
          status: "PENDING",
        },
      });

      for (const referral of referrals) {
        const ev = await grantForReferral(referral);
        events.push(...ev);
      }
    } catch (error) {
      // Never break settlement. Emit whatever already committed.
      if (!error || error.code !== "P2002") {
        console.warn(
          `Referral reward pass skipped: ${
            error && error.message ? error.message : error
          }`
        );
      }
    }
    return events;
  };
}

const grantReferralRewardsForRace = buildGrantReferralRewardsForRace();

module.exports = {
  buildGrantReferralRewardsForRace,
  grantReferralRewardsForRace,
};
