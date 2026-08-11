const { prisma } = require("../../../db");
const { awardCoins } = require("../../../shared/economy/awardCoins");
const { withAdvisoryLock } = require("../../../shared/db/withAdvisoryLock");
const { recordServerActivationEvent } = require("../../analytics/serverActivationEvents");
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
  async function grantRole(store, { referralId, userId, role, refereeSubHash, coins }) {
    const inserted = await store.referralRewardGrant.createMany({
      data: [{ referralId, userId, role, refereeSubHash, coins }],
      skipDuplicates: true,
    });
    if (inserted.count === 0) return false;
    await awardCoinsFn({
      userId,
      amount: coins,
      reason: "referral_reward",
      refId: `referral:${referralId}:${role}`,
      tx: store,
    });
    return true;
  }

  async function isReviewAccount(store, userId) {
    if (!userId) return false;
    const user = await store.user.findUnique({
      where: { id: userId },
      select: { isReviewAccount: true },
    });
    return user?.isReviewAccount === true;
  }

  // Velocity cap (§8.7): true when this referrer has already been paid as many
  // REFERRER rewards as the daily/monthly cap allows within the trailing window.
  // Counts committed REFERRER grants (grantedAt), so the (cap+1)th referral is
  // the one that gets held. A burst past the cap is the signature of a ring.
  async function referrerOverVelocityCap(store, referrerId, decisionTime) {
    const dayStart = new Date(decisionTime.getTime() - DAY_MS);
    const monthStart = new Date(decisionTime.getTime() - 30 * DAY_MS);
    const [dayCount, monthCount] = await Promise.all([
      store.referralRewardGrant.count({
        where: {
          userId: referrerId,
          role: "REFERRER",
          grantedAt: { gte: dayStart },
        },
      }),
      store.referralRewardGrant.count({
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
  async function grantForReferral(initialReferral) {
    const events = [];
    const lockId = initialReferral.referrerId
      ? `referral-velocity:${initialReferral.referrerId}`
      : `referral:${initialReferral.id}`;
    await withAdvisoryLock(lockId, async (tx) => {
      const referral = await tx.referral.findUnique({ where: { id: initialReferral.id } });
      if (!referral || referral.status !== "PENDING") return;
      const decisionTime = now();
      const ageMs = decisionTime.getTime() - new Date(referral.createdAt).getTime();
      if (ageMs > QUALIFY_WINDOW_DAYS * DAY_MS) {
        await tx.referral.update({ where: { id: referral.id }, data: { status: "EXPIRED" } });
        return;
      }
      if (await isReviewAccount(tx, referral.refereeId)) {
        await tx.referral.update({ where: { id: referral.id }, data: { status: "EXCLUDED" } });
        return;
      }
      const referrerEligible =
        referral.referrerId != null &&
        !(await isReviewAccount(tx, referral.referrerId));
      if (
        referrerEligible &&
        (await referrerOverVelocityCap(tx, referral.referrerId, decisionTime))
      ) {
        await tx.referral.update({ where: { id: referral.id }, data: { status: "FLAGGED" } });
        console.warn(
          `Referral ${referral.id} held for review: referrer ${referral.referrerId} over velocity cap`
        );
        return;
      }
      const roleGrants = [];
      if (referrerEligible) {
        roleGrants.push({
          referralId: referral.id,
          userId: referral.referrerId,
          role: "REFERRER",
          refereeSubHash: referral.refereeSubHash,
          coins: REFERRER_REWARD_COINS,
        });
      }
      roleGrants.push({
        referralId: referral.id,
        userId: referral.refereeId,
        role: "REFEREE",
        refereeSubHash: referral.refereeSubHash,
        coins: REFEREE_REWARD_COINS,
      });
      roleGrants.sort((a, b) => String(a.userId).localeCompare(String(b.userId)));
      for (const roleGrant of roleGrants) {
        const paid = await grantRole(tx, roleGrant);
        if (paid && roleGrant.role === "REFERRER") {
          events.push({
            referrerId: referral.referrerId,
            refereeId: referral.refereeId,
            coins: REFERRER_REWARD_COINS,
          });
        }
      }
      await tx.referral.update({ where: { id: referral.id }, data: { status: "REWARDED" } });
      if (referral.sourceRaceId) {
        await recordServerActivationEvent({
          db: tx,
          id: `server:race-share-qualified:${referral.id}`,
          userId: referral.referrerId || referral.refereeId,
          name: "race_share_referral_qualified",
          context: {
            source_race_id: referral.sourceRaceId,
            qualification_latency_seconds: String(
              Math.max(0, Math.floor(ageMs / 1000))
            ),
          },
          occurredAt: decisionTime,
        });
      }
    }, { prisma: db });
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
        (p) =>
          p.status === "ACCEPTED" &&
          typeof p.rawSteps === "number" &&
          p.rawSteps >= 2000
      );
      const isQualifyingRace =
        race.seedId == null && realParticipants.length >= 2;
      if (!isQualifyingRace) return events;

      // Settled finishers who actually walked (not no-shows).
      const finishers = race.participants.filter(
        (p) =>
          p.status === "ACCEPTED" &&
          p.placement != null &&
          typeof p.rawSteps === "number" &&
          p.rawSteps >= 2000
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
      referrals.sort((a, b) =>
        String(a.refereeId || "").localeCompare(String(b.refereeId || ""))
      );

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
