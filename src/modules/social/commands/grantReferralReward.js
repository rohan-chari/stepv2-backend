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
const {
  isReferralQualifyingRace,
  qualifyingParticipants,
} = require("../services/referralQualification");

const DAY_MS = 24 * 60 * 60 * 1000;

async function countEarlierEligiblePendingFacts(store, referrerId, at, referralFactId, windowMs) {
  const rows = await store.$queryRaw`
    SELECT COUNT(*)::int AS count
    FROM referral_qualification_facts
    WHERE referrer_id = ${referrerId}
      AND status = 'PENDING'
      AND qualified_at >= ${new Date(at.getTime() - windowMs)}
      AND qualified_at <= ${at}
      AND (qualified_at < ${at}
        OR (qualified_at = ${at} AND referral_fact_id < ${referralFactId}))
      AND referrer_was_review = false
      AND referee_was_review = false
      AND referral_created_at <= qualified_at
      AND referral_created_at >= qualified_at - (${QUALIFY_WINDOW_DAYS} * INTERVAL '1 day')
  `;
  return Number(rows[0]?.count || 0);
}

function buildGrantQualifiedReferralReward(dependencies = {}) {
  const rootDb = dependencies.prisma || prisma;
  const award = dependencies.awardCoins || awardCoins;
  const nowFn = dependencies.now || (() => new Date());

  async function grantRole(store, { referralId, userId, role, refereeSubHash, coins, qualifiedAtSnapshot }) {
    if (!userId) return false;
    const inserted = await store.referralRewardGrant.createMany({
      data: [{ referralId, userId, role, refereeSubHash, coins, qualifiedAtSnapshot }],
      skipDuplicates: true,
    });
    if (inserted.count === 0) return false;
    await award({
      userId,
      amount: coins,
      reason: "referral_reward",
      refId: `referral:${referralId}:${role}`,
      tx: store,
    });
    return true;
  }

  async function reviewAccount(store, userId) {
    if (!userId) return false;
    return (await store.user.findUnique({
      where: { id: userId }, select: { isReviewAccount: true },
    }))?.isReviewAccount === true;
  }

  async function setReferralStatus(store, referral, status) {
    await store.referral.update({ where: { id: referral.id }, data: { status } });
    await store.referralQualificationFact.updateMany({
      where: { referralFactId: referral.id }, data: { status },
    });
  }

  async function overVelocityCap(store, referrerId, at, referralFactId) {
    const [daily, monthly, pendingDaily, pendingMonthly] = await Promise.all([
      store.referralRewardGrant.count({ where: {
        userId: referrerId, role: "REFERRER",
        OR: [
          { qualifiedAtSnapshot: { gte: new Date(at.getTime() - DAY_MS), lte: at } },
          { qualifiedAtSnapshot: null, grantedAt: { gte: new Date(at.getTime() - DAY_MS), lte: at } },
        ],
      } }),
      store.referralRewardGrant.count({ where: {
        userId: referrerId, role: "REFERRER",
        OR: [
          { qualifiedAtSnapshot: { gte: new Date(at.getTime() - 30 * DAY_MS), lte: at } },
          { qualifiedAtSnapshot: null, grantedAt: { gte: new Date(at.getTime() - 30 * DAY_MS), lte: at } },
        ],
      } }),
      countEarlierEligiblePendingFacts(store, referrerId, at, referralFactId, DAY_MS),
      countEarlierEligiblePendingFacts(store, referrerId, at, referralFactId, 30 * DAY_MS),
    ]);
    return daily + pendingDaily >= REFERRAL_DAILY_CAP ||
      monthly + pendingMonthly >= REFERRAL_MONTHLY_CAP;
  }

  return async function grantQualifiedReferralReward({
    referralId,
    manualApproval = false,
    db = rootDb,
    now = nowFn,
  }) {
    const initial = await db.referral.findUnique({ where: { id: referralId } });
    if (!initial) return { events: [], status: "MISSING" };
    const events = [];
    const commitGrant = async (tx) => {
        await tx.$queryRaw`SELECT id FROM referrals WHERE id = ${referralId} FOR UPDATE`;
        const referral = await tx.referral.findUnique({ where: { id: referralId } });
        if (!referral || referral.status === "REWARDED") return;
        if (manualApproval ? referral.status !== "FLAGGED" : referral.status !== "PENDING") return;
        if (!referral.qualifiedAt || (!manualApproval && !referral.qualifyingRaceId)) return;

        const qualificationTime = new Date(referral.qualifiedAt);
        const ageMs = qualificationTime.getTime() - new Date(referral.createdAt).getTime();
        if (ageMs < 0 || ageMs > QUALIFY_WINDOW_DAYS * DAY_MS) {
          await setReferralStatus(tx, referral, "EXPIRED");
          return;
        }
        if (await reviewAccount(tx, referral.refereeId)) {
          await setReferralStatus(tx, referral, "EXCLUDED");
          return;
        }
        const referrerEligible = referral.referrerId != null &&
          !(await reviewAccount(tx, referral.referrerId));
        if (!manualApproval && referrerEligible &&
            await overVelocityCap(tx, referral.referrerId, qualificationTime, referral.id)) {
          await setReferralStatus(tx, referral, "FLAGGED");
          return;
        }

        const grants = [
          ...(referrerEligible ? [{
            referralId: referral.id, userId: referral.referrerId,
            role: "REFERRER", refereeSubHash: referral.refereeSubHash,
            coins: REFERRER_REWARD_COINS, qualifiedAtSnapshot: qualificationTime,
          }] : []),
          {
            referralId: referral.id, userId: referral.refereeId,
            role: "REFEREE", refereeSubHash: referral.refereeSubHash,
            coins: REFEREE_REWARD_COINS, qualifiedAtSnapshot: qualificationTime,
          },
        ].sort((a, b) => String(a.userId).localeCompare(String(b.userId)));
        for (const grant of grants) {
          if (await grantRole(tx, grant) && grant.role === "REFERRER") {
            events.push({
              referrerId: referral.referrerId,
              refereeId: referral.refereeId,
              coins: REFERRER_REWARD_COINS,
            });
          }
        }
        await setReferralStatus(tx, referral, "REWARDED");
        if (referral.sourceRaceId) {
          await recordServerActivationEvent({
            db: tx,
            id: `server:race-share-qualified:${referral.id}`,
            userId: referral.referrerId || referral.refereeId,
            name: "race_share_referral_qualified",
            context: {
              source_race_id: referral.sourceRaceId,
              qualification_latency_seconds: String(Math.max(0, Math.floor(ageMs / 1000))),
            },
            occurredAt: qualificationTime,
          });
        }
    };
    if (typeof db.$transaction === "function") {
      await withAdvisoryLock(
        initial.referrerId ? `referral-velocity:${initial.referrerId}` : `referral:${initial.id}`,
        commitGrant,
        { prisma: db },
      );
    } else {
      // An owning transaction (admin review) already holds the referral row.
      await commitGrant(db);
    }
    const current = await db.referral.findUnique({ where: { id: referralId }, select: { status: true } });
    return { events, status: current?.status || "MISSING" };
  };
}

const grantQualifiedReferralReward = buildGrantQualifiedReferralReward();

async function adjudicateDetachedReferralQualification({
  referralFactId,
  db = prisma,
}) {
  if (!referralFactId) return { status: "MISSING" };
  const initial = await db.referralQualificationFact.findUnique({
    where: { referralFactId },
    select: { referrerId: true },
  });
  if (!initial) return { status: "MISSING" };
  return withAdvisoryLock(
    initial.referrerId ? `referral-velocity:${initial.referrerId}` : `referral-fact:${referralFactId}`,
    async (tx) => {
    await tx.$queryRaw`
      SELECT id FROM referral_qualification_facts
      WHERE referral_fact_id = ${referralFactId}
      FOR UPDATE
    `;
    const fact = await tx.referralQualificationFact.findUnique({
      where: { referralFactId },
    });
    if (!fact || fact.status !== "PENDING") {
      return { status: fact?.status || "MISSING" };
    }
    const ageMs = new Date(fact.qualifiedAt).getTime() -
      new Date(fact.referralCreatedAt).getTime();
    let status = "QUALIFIED";
    if (ageMs < 0 || ageMs > QUALIFY_WINDOW_DAYS * DAY_MS) {
      status = "EXPIRED";
    } else if (fact.refereeWasReview || fact.referrerWasReview) {
      status = "EXCLUDED";
    } else if (fact.referrerId && await overVelocityForDetached(
      tx, fact.referrerId, fact.qualifiedAt, fact.referralFactId,
    )) {
      status = "FLAGGED";
    }
    await tx.referralQualificationFact.update({
      where: { id: fact.id },
      data: { status },
    });
    return { status };
    },
    { prisma: db },
  );
}

async function overVelocityForDetached(store, referrerId, qualifiedAt, referralFactId) {
  const at = new Date(qualifiedAt);
  const [daily, monthly, pendingDaily, pendingMonthly] = await Promise.all([
    store.referralRewardGrant.count({ where: {
      userId: referrerId,
      role: "REFERRER",
      OR: [
        { qualifiedAtSnapshot: { gte: new Date(at.getTime() - DAY_MS), lte: at } },
        { qualifiedAtSnapshot: null, grantedAt: { gte: new Date(at.getTime() - DAY_MS), lte: at } },
      ],
    } }),
    store.referralRewardGrant.count({ where: {
      userId: referrerId,
      role: "REFERRER",
      OR: [
        { qualifiedAtSnapshot: { gte: new Date(at.getTime() - 30 * DAY_MS), lte: at } },
        { qualifiedAtSnapshot: null, grantedAt: { gte: new Date(at.getTime() - 30 * DAY_MS), lte: at } },
      ],
    } }),
    countEarlierEligiblePendingFacts(store, referrerId, at, referralFactId, DAY_MS),
    countEarlierEligiblePendingFacts(store, referrerId, at, referralFactId, 30 * DAY_MS),
  ]);
  return daily + pendingDaily >= REFERRAL_DAILY_CAP ||
    monthly + pendingMonthly >= REFERRAL_MONTHLY_CAP;
}

function buildGrantReferralRewardsForRace(dependencies = {}) {
  const db = dependencies.prisma || prisma;
  const now = dependencies.now || (() => new Date());
  return async function grantReferralRewardsForRace({ race }) {
    try {
    if (!isReferralQualifyingRace(race)) return [];
    const finishers = qualifyingParticipants(race)
      .filter((participant) => participant.placement != null)
      .map((participant) => participant.userId);
    if (finishers.length === 0) return [];
    const { createReferralQualificationIntents } = require("./processReferralQualificationIntents");
    await db.$transaction(async (tx) => {
      await createReferralQualificationIntents({
        tx, raceId: race.id, qualifiedAt: race.completedAt || now(),
        participantUserIds: finishers, seedId: race.seedId, tournamentId: race.tournamentId,
      });
    });
    const events = [];
    const { processReferralQualificationIntents } = require("./processReferralQualificationIntents");
    await processReferralQualificationIntents({
      raceId: race.id,
      db,
      now,
      rewardOne: async ({ referralId }) => {
        const result = await (dependencies.grantQualifiedReferralReward || grantQualifiedReferralReward)({ referralId, db, now });
        events.push(...result.events);
      },
    });
    return events;
    } catch (error) {
      console.warn(`Referral reward pass skipped: ${error?.message || error}`);
      return [];
    }
  };
}

const grantReferralRewardsForRace = buildGrantReferralRewardsForRace();

async function approveFlaggedReferralReward({ referralId, db = prisma, now = () => new Date() }) {
  return grantQualifiedReferralReward({ referralId, manualApproval: true, db, now });
}

module.exports = {
  adjudicateDetachedReferralQualification,
  approveFlaggedReferralReward,
  buildGrantQualifiedReferralReward,
  buildGrantReferralRewardsForRace,
  grantQualifiedReferralReward,
  grantReferralRewardsForRace,
};
