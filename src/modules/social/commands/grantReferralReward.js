const { prisma } = require("../../../db");
const { awardCoins } = require("../../../shared/economy/awardCoins");
const {
  REFERRER_REWARD_COINS,
  REFEREE_REWARD_COINS,
  QUALIFY_WINDOW_DAYS,
  REFERRAL_DAILY_CAP,
  REFERRAL_MONTHLY_CAP,
} = require("../referralRewards");

const DAY_MS = 24 * 60 * 60 * 1000;

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

  async function isReviewAccount(userId) {
    if (!userId) return false;
    const user = await db.user.findUnique({
      where: { id: userId },
      select: { isReviewAccount: true },
    });
    return user?.isReviewAccount === true;
  }

  // Velocity cap (§8.7): true when this referrer has already been paid as many
  // REFERRER rewards as the daily/monthly cap allows within the trailing window.
  // Counts committed REFERRER grants (grantedAt), so the (cap+1)th referral is
  // the one that gets held. A burst past the cap is the signature of a ring.
  async function referrerOverVelocityCap(referrerId) {
    const dayStart = new Date(now().getTime() - DAY_MS);
    const monthStart = new Date(now().getTime() - 30 * DAY_MS);
    const [dayCount, monthCount] = await Promise.all([
      db.referralRewardGrant.count({
        where: {
          userId: referrerId,
          role: "REFERRER",
          grantedAt: { gte: dayStart },
        },
      }),
      db.referralRewardGrant.count({
        where: {
          userId: referrerId,
          role: "REFERRER",
          grantedAt: { gte: monthStart },
        },
      }),
    ]);
    return dayCount >= REFERRAL_DAILY_CAP || monthCount >= REFERRAL_MONTHLY_CAP;
  }

  // Process one PENDING attribution. Returns REFERRAL_REWARDED payloads to emit.
  async function grantForReferral(referral) {
    const events = [];

    // Attribution-window check: a stale PENDING attribution never pays out.
    const ageMs = now().getTime() - new Date(referral.createdAt).getTime();
    if (ageMs > QUALIFY_WINDOW_DAYS * DAY_MS) {
      await db.referral.update({
        where: { id: referral.id },
        data: { status: "EXPIRED" },
      });
      return events;
    }

    // Review/demo-account exclusion (§8.10): a review-account referee never
    // triggers a payout. Mark EXCLUDED (terminal) so it doesn't re-process on
    // every later race.
    if (await isReviewAccount(referral.refereeId)) {
      await db.referral.update({
        where: { id: referral.id },
        data: { status: "EXCLUDED" },
      });
      return events;
    }

    const { refereeSubHash } = referral;

    // The referrer earns only if they still exist (referrerId not SetNull'd by
    // account deletion) AND are not a review/demo account.
    const referrerEligible =
      referral.referrerId != null &&
      !(await isReviewAccount(referral.referrerId));

    // Velocity cap: hold the WHOLE referral (both sides) for manual review when
    // the referrer is over the cap. Holding the referee too is intentional — a
    // burst past the cap looks like a ring, so nothing auto-pays until a human
    // clears it (flips FLAGGED -> PENDING or grants manually). Skipped when the
    // referrer is ineligible (deleted/review) — there's no one to rate-limit.
    if (referrerEligible && (await referrerOverVelocityCap(referral.referrerId))) {
      await db.referral.update({
        where: { id: referral.id },
        data: { status: "FLAGGED" },
      });
      console.warn(
        `Referral ${referral.id} held for review: referrer ${referral.referrerId} over velocity cap`
      );
      return events;
    }

    // Referrer side — skip if ineligible (deleted/review); the referee is still
    // paid below.
    if (referrerEligible) {
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

      // Qualifying-race gate (anti-farm, §5C.2 / §8.1; TIGHTENED by batch
      // 2026-08-09 item 2).
      //
      // A qualifying race is a NON-SEEDED race with a genuine multi-person
      // field: at least 2 distinct ACCEPTED participants who actually accrued
      // steps. Both halves are required.
      //
      // The seeded half used to be an OR that qualified unconditionally, even
      // solo. That was wrong in practice rather than in theory: `autoEnrollNewUser`
      // puts every new account into every seeded daily/weekly, so a referred
      // user completed their referrer's payout within ~24h having done nothing
      // but sync steps once. The referral is meant to pay for bringing someone
      // into a REAL race with real people, so a system-seeded challenge now
      // never qualifies, at any field size.
      //
      // This also makes the payout gate consistent with the redeem-window guard
      // in redeemReferralCode.js, which has always counted only `seedId: null`
      // races. The two used to treat seeded races oppositely.
      //
      // In-flight PENDING referrals are subject to the new rule immediately
      // (owner decision): no migration, no grandfathering — they can still
      // qualify via a real race inside their 30-day window.
      //
      // POLARITY HAZARD, explicitly closed below. Flipping `!= null` to
      // `== null` also flips the failure mode from fail-CLOSED to fail-OPEN: a
      // caller handing over a race projection that never SELECTed `seedId`
      // would have `undefined == null` evaluate TRUE and silently re-qualify
      // every seeded daily. Today's only callers (completeRace's two sites) go
      // through Race.findById, which uses `include` and therefore carries every
      // scalar — but "today's callers are fine" is not a guarantee, and the
      // consequence of a future lean `select:` is a silent regression of the
      // exact vector this change exists to close. So the KEY's presence is
      // required, not just its value.
      const hasSeedIdField = Object.prototype.hasOwnProperty.call(race, "seedId");
      if (!hasSeedIdField) {
        console.warn(
          "referral gate: race projection is missing seedId — treating as non-qualifying",
          { raceId: race.id }
        );
        return events;
      }

      const realParticipants = race.participants.filter(
        (p) => p.status === "ACCEPTED" && (p.totalSteps || 0) > 0
      );
      const isQualifyingRace =
        race.seedId == null && realParticipants.length >= 2;
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
        // Per-referral isolation: a concurrent manual redeem may replace a
        // PENDING ip_fallback_net attribution (delete + recreate) between our
        // grants and the status update, throwing P2025 — that referral's pass
        // is void, but the other finishers in this settlement must not lose
        // theirs. The ledger unique makes a retry of the voided one safe.
        try {
          const ev = await grantForReferral(referral);
          events.push(...ev);
        } catch (error) {
          console.warn(
            `Referral reward skipped for ${referral.id}: ${
              error && error.message ? error.message : error
            }`
          );
        }
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
