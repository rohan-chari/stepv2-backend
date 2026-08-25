const { prisma } = require("../../../db");

// Giveaway is a consumer of social-owned immutable referral facts. Keeping the
// query here prevents the promotion domain from growing a second interpretation
// of referral qualification state.
async function getGiveawayReferralFacts({
  referrerIds,
  startsAt,
  endsAt,
  db = prisma,
}) {
  if (!Array.isArray(referrerIds) || referrerIds.length === 0) return [];
  const durable = await db.referralQualificationFact.findMany({
    where: {
      referrerId: { in: referrerIds },
      referrer: { isReviewAccount: false },
      qualifiedAt: { gte: startsAt, lt: endsAt },
    },
    select: {
      referralFactId: true,
      referrerId: true,
      refereeIdentityHash: true,
      attributionSource: true,
      status: true,
      qualifiedAt: true,
      qualifyingRaceId: true,
      createdAt: true,
    },
  });
  const durableIds = durable.map((fact) => fact.referralFactId);
  const durableIdentityHashes = durable.map((fact) => fact.refereeIdentityHash);
  const durableLiveRows = durableIds.length ? await db.referral.findMany({
    where: { id: { in: durableIds } },
    select: { id: true, refereeId: true, code: true },
  }) : [];
  const durableLiveById = new Map(durableLiveRows.map((row) => [row.id, row]));
  // Compatibility for facts written in the same deploy window before the
  // durable processor has acknowledged them, and for deterministic fixtures.
  let live = await db.referral.findMany({
    where: {
      id: { notIn: durableIds },
      refereeSubHash: { notIn: durableIdentityHashes },
      referrerId: { in: referrerIds },
      referrer: { isReviewAccount: false },
      qualifiedAt: { gte: startsAt, lt: endsAt },
    },
    select: {
      id: true, referrerId: true, refereeId: true, refereeSubHash: true, code: true,
      source: true, status: true, qualifiedAt: true, qualifyingRaceId: true, createdAt: true,
    },
  });
  if (live.length) {
    const globallyClaimed = await db.referralQualificationFact.findMany({
      where: { refereeIdentityHash: { in: live.map((fact) => fact.refereeSubHash) } },
      select: { refereeIdentityHash: true },
    });
    const claimedHashes = new Set(globallyClaimed.map((fact) => fact.refereeIdentityHash));
    live = live.filter((fact) => !claimedHashes.has(fact.refereeSubHash));
  }
  return [
    ...durable.map((fact) => ({
      id: fact.referralFactId,
      referrerId: fact.referrerId,
      refereeId: durableLiveById.get(fact.referralFactId)?.refereeId || null,
      referralCode: durableLiveById.get(fact.referralFactId)?.code || null,
      refereeIdentityHash: fact.refereeIdentityHash,
      attributionSource: fact.attributionSource,
      status: fact.status,
      qualifiedAt: fact.qualifiedAt,
      qualifyingRaceId: fact.qualifyingRaceId,
      createdAt: fact.createdAt,
    })),
    ...live.map((fact) => ({
      id: fact.id,
      referrerId: fact.referrerId,
      refereeId: fact.refereeId,
      referralCode: fact.code || null,
      refereeIdentityHash: fact.refereeSubHash,
      attributionSource: fact.source,
      status: fact.status,
      qualifiedAt: fact.qualifiedAt,
      qualifyingRaceId: fact.qualifyingRaceId,
      createdAt: fact.createdAt,
    })),
  ].sort((a, b) => new Date(a.qualifiedAt) - new Date(b.qualifiedAt) || a.id.localeCompare(b.id));
}

module.exports = { getGiveawayReferralFacts };
