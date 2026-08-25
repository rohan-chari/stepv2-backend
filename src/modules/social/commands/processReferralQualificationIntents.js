const crypto = require("node:crypto");
const { prisma } = require("../../../db");

async function processReferralQualificationIntents({
  limit = 100,
  before = null,
  raceId = null,
  processOne = null,
  rewardOne = null,
  afterRewardCommitted = null,
  retryDelayMs = 60 * 1000,
  db = prisma,
  now = () => new Date(),
  throwOnError = Boolean(processOne || afterRewardCommitted),
} = {}) {
  if (!db?.referralQualificationIntent) return { processed: 0, remaining: 0 };
  const bounded = Math.max(1, Math.min(500, Number(limit) || 100));
  const retryBefore = new Date(now().getTime() - Math.max(0, Number(retryDelayMs) || 0));
  const intents = await db.referralQualificationIntent.findMany({
    where: {
      processedAt: null,
      OR: [{ attemptedAt: null }, { attemptedAt: { lte: retryBefore } }],
      ...(before ? { qualifiedAt: { lt: before } } : {}),
      ...(raceId ? { qualifyingRaceId: raceId } : {}),
    },
    orderBy: [{ qualifiedAt: "asc" }, { id: "asc" }],
    take: bounded,
  });
  let processed = 0;
  for (const intent of intents) {
    const attemptedAt = now();
    const claimed = await db.$transaction(async (tx) => {
      const rows = await tx.$queryRaw`
        SELECT id FROM referral_qualification_intents
        WHERE id = ${intent.id} AND processed_at IS NULL
        FOR UPDATE SKIP LOCKED
      `;
      if (!rows.length) return false;
      const updated = await tx.referralQualificationIntent.updateMany({
        where: { id: intent.id, processedAt: null, OR: [{ attemptedAt: null }, { attemptedAt: { lte: retryBefore } }] },
        data: { attemptedAt, attemptCount: { increment: 1 }, lastError: null },
      });
      return updated.count === 1;
    });
    if (!claimed) continue;
    try {
      if (typeof processOne === "function") await processOne(intent);
      // Settlement owns this immutable fact. Stamp it before any optional
      // reward work so review/recovery always retains the original race time.
      await db.$transaction(async (tx) => {
        const referral = intent.referralId
          ? await tx.referral.findUnique({ where: { id: intent.referralId } })
          : null;
        if (!referral) return;
        await tx.referral.updateMany({
          where: { id: intent.referralId, OR: [{ qualifiedAt: null }, { qualifiedAt: { gt: intent.qualifiedAt } }] },
          data: { qualifiedAt: intent.qualifiedAt, qualifyingRaceId: intent.qualifyingRaceId },
        });
      });
      const reward = rewardOne || require("./grantReferralReward").grantQualifiedReferralReward;
      const rewardResult = intent.referralId
        ? await reward({ referralId: intent.referralId, db, now })
        : { status: "MISSING" };
      if (!intent.referralId || rewardResult?.status === "MISSING") {
        const { adjudicateDetachedReferralQualification } = require("./grantReferralReward");
        await adjudicateDetachedReferralQualification({ referralFactId: intent.referralFactId, db });
      }
      const ownedFact = await db.referralQualificationFact.findUnique({
        where: { referralFactId: intent.referralFactId },
        select: { status: true },
      });
      if (ownedFact?.status === "PENDING") {
        throw new Error("Referral qualification adjudication is still pending");
      }
      // Fault seam models a process dying after the idempotent reward/status
      // transaction commits but before the intent acknowledgement.
      if (typeof afterRewardCommitted === "function") await afterRewardCommitted(intent);
      await db.referralQualificationIntent.updateMany({
        where: { id: intent.id, processedAt: null },
        data: { processedAt: now(), lastError: null },
      });
      processed += 1;
    } catch (error) {
      await db.referralQualificationIntent.update({
        where: { id: intent.id },
        data: { lastError: String(error?.message || error).slice(0, 500) },
      });
      if (throwOnError) throw error;
    }
  }
  return { processed, remaining: Math.max(0, intents.length - processed) };
}

async function createReferralQualificationIntents({
  tx,
  raceId,
  qualifiedAt,
  participantUserIds,
  seedId,
  tournamentId,
}) {
  if (!tx || !raceId || !(qualifiedAt instanceof Date)) return { count: 0 };
  if (seedId != null || tournamentId != null || !Array.isArray(participantUserIds)) return { count: 0 };
  const uniqueUserIds = [...new Set(participantUserIds.filter(Boolean))];
  if (uniqueUserIds.length < 2) return { count: 0 };
  const referrals = await tx.referral.findMany({
    where: { refereeId: { in: uniqueUserIds }, status: "PENDING" },
    select: {
      id: true,
      referrerId: true,
      refereeSubHash: true,
      source: true,
      createdAt: true,
      referrer: { select: { isReviewAccount: true } },
      referee: { select: { isReviewAccount: true } },
    },
  });
  if (referrals.length === 0) return { count: 0 };
  for (const referral of referrals) {
    await tx.$executeRaw`
      INSERT INTO referral_qualification_facts
        (id, referral_fact_id, referrer_id, referee_identity_hash,
         attribution_source, qualifying_race_id, qualified_at,
         referral_created_at, referrer_was_review, referee_was_review, status,
         created_at, updated_at)
      VALUES
        (${crypto.randomUUID()}, ${referral.id}, ${referral.referrerId},
         ${referral.refereeSubHash}, ${referral.source}, ${raceId},
         ${qualifiedAt}, ${referral.createdAt},
         ${referral.referrer?.isReviewAccount === true},
         ${referral.referee?.isReviewAccount === true},
         'PENDING', NOW(), NOW())
      ON CONFLICT (referee_identity_hash) DO UPDATE SET
        referral_fact_id = EXCLUDED.referral_fact_id,
        referrer_id = EXCLUDED.referrer_id,
        attribution_source = EXCLUDED.attribution_source,
        qualifying_race_id = EXCLUDED.qualifying_race_id,
        qualified_at = EXCLUDED.qualified_at,
        referral_created_at = EXCLUDED.referral_created_at,
        referrer_was_review = EXCLUDED.referrer_was_review,
        referee_was_review = EXCLUDED.referee_was_review,
        status = 'PENDING',
        updated_at = NOW()
      WHERE EXCLUDED.qualified_at < referral_qualification_facts.qualified_at
    `;
  }
  return tx.referralQualificationIntent.createMany({
    data: referrals.map((referral) => ({
      referralId: referral.id,
      referralFactId: referral.id,
      referrerIdSnapshot: referral.referrerId,
      qualifyingRaceId: raceId,
      qualifiedAt,
    })),
    skipDuplicates: true,
  });
}

async function hasPendingReferralQualificationIntents({
  entrantWindows,
  startsAt,
  endsAt,
  db = prisma,
}) {
  if (!Array.isArray(entrantWindows) || entrantWindows.length === 0) return false;
  const windows = entrantWindows
    .filter((entry) => entry?.userId && entry?.rulesAcceptedAt)
    .map((entry) => ({
      userId: entry.userId,
      acceptedAt: new Date(Math.max(
        new Date(startsAt).getTime(),
        new Date(entry.rulesAcceptedAt).getTime(),
      )),
    }));
  if (windows.length === 0) return false;
  const intents = await db.referralQualificationIntent.findMany({
    where: {
      processedAt: null,
      qualifiedAt: { gte: new Date(startsAt), lt: new Date(endsAt) },
      OR: windows.map((entry) => ({
        referrerIdSnapshot: entry.userId,
        qualifiedAt: { gte: entry.acceptedAt, lt: new Date(endsAt) },
      })),
    },
    select: { referralFactId: true, referrerIdSnapshot: true },
  });
  if (intents.length === 0) return false;
  const ownedPending = await db.referralQualificationFact.findMany({
    where: {
      referralFactId: { in: intents.map((intent) => intent.referralFactId) },
      status: "PENDING",
    },
    select: { referralFactId: true, referrerId: true },
  });
  const intentOwners = new Map(intents.map((intent) => [
    intent.referralFactId,
    intent.referrerIdSnapshot,
  ]));
  return ownedPending.some((fact) =>
    fact.referrerId != null && fact.referrerId === intentOwners.get(fact.referralFactId));
}

module.exports = {
  createReferralQualificationIntents,
  hasPendingReferralQualificationIntents,
  processReferralQualificationIntents,
};
