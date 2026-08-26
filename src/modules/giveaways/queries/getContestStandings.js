const { prisma } = require("../../../db");
const { getGiveawayReferralFacts } = require("../../social");
const { classifyReferralFact } = require("../models/referralFactState");

function compareRows(a, b) {
  if (b.verifiedCount !== a.verifiedCount) return b.verifiedCount - a.verifiedCount;
  const left = a.reachedCountAt ? new Date(a.reachedCountAt).getTime() : Number.MAX_SAFE_INTEGER;
  const right = b.reachedCountAt ? new Date(b.reachedCountAt).getTime() : Number.MAX_SAFE_INTEGER;
  if (left !== right) return left - right;
  return a.entrantId.localeCompare(b.entrantId);
}

async function getContestStandings(contest, { db = prisma, asOf = null } = {}) {
  const entrants = await db.giveawayEntrant.findMany({
    where: { contestId: contest.id, status: { in: ["ELIGIBLE", "UNDER_REVIEW"] }, userId: { not: null }, displayNameSnapshot: { not: null }, ...(asOf ? { createdAt: { lte: asOf } } : {}) },
    select: {
      id: true, userId: true, status: true, displayNameSnapshot: true,
      rulesAcceptedAt: true, createdAt: true,
    },
  });
  const facts = await getGiveawayReferralFacts({
    referrerIds: entrants.map((entry) => entry.userId),
    startsAt: contest.startsAt,
    endsAt: contest.endsAt,
    db,
  });
  const visibleFacts = asOf ? facts.filter((fact) => new Date(fact.createdAt) <= asOf) : facts;
  const reviews = visibleFacts.length === 0 ? [] : await db.giveawayPointReview.findMany({
    where: { contestId: contest.id, referralFactId: { in: visibleFacts.map((fact) => fact.id) } },
  });
  const reviewByFact = new Map(reviews.map((review) => [review.referralFactId, review]));
  const factsByUser = new Map();
  for (const fact of visibleFacts) {
    if (!factsByUser.has(fact.referrerId)) factsByUser.set(fact.referrerId, []);
    factsByUser.get(fact.referrerId).push(fact);
  }
  const rows = entrants.map((entry) => {
    const acceptedAt = new Date(entry.rulesAcceptedAt);
    const relevant = (factsByUser.get(entry.userId) || []).filter((fact) => new Date(fact.qualifiedAt) >= acceptedAt);
    const verified = [];
    let reviewableCount = 0;
    for (const fact of relevant) {
      const review = reviewByFact.get(fact.id);
      const state = classifyReferralFact(fact, review);
      if (state === "VERIFIED") {
        verified.push(fact);
      } else if (state === "REVIEWABLE") {
        reviewableCount += 1;
      }
    }
    verified.sort((a, b) => new Date(a.qualifiedAt) - new Date(b.qualifiedAt) || a.id.localeCompare(b.id));
    return {
      entrantId: entry.id,
      userId: entry.userId,
      displayName: entry.displayNameSnapshot,
      entryStatus: entry.status,
      verifiedCount: verified.length,
      reviewableCount,
      reachedCountAt: verified.length ? verified[verified.length - 1].qualifiedAt : null,
      verifiedFactIds: verified.map((fact) => fact.id),
      reviewableFactIds: relevant
        .filter((fact) => classifyReferralFact(fact, reviewByFact.get(fact.id)) === "REVIEWABLE")
        .map((fact) => fact.id),
      reviewableFacts: relevant
        .filter((fact) => classifyReferralFact(fact, reviewByFact.get(fact.id)) === "REVIEWABLE")
        .map((fact) => ({ id: fact.id, qualifiedAt: fact.qualifiedAt, qualifyingRaceId: fact.qualifyingRaceId })),
      auditFacts: relevant
        .map((fact) => ({
          id: fact.id,
          qualifiedAt: fact.qualifiedAt,
          qualifyingRaceId: fact.qualifyingRaceId,
          refereeId: fact.refereeId || null,
          refereeIdentityHash: fact.refereeIdentityHash,
          attributionSource: fact.attributionSource || "unknown",
          referralCode: fact.referralCode || null,
          status: fact.status,
        })),
    };
  });
  rows.sort(compareRows);
  let visibleRank = 0;
  for (const row of rows) {
    if (row.verifiedCount > 0) visibleRank += 1;
    row.provisionalRank = row.verifiedCount > 0 ? visibleRank : null;
  }
  return rows;
}

async function getFinalStandings(contest, { db = prisma } = {}) {
  const results = await db.giveawayResult.findMany({
    where: { entrant: { contestId: contest.id } },
    include: { entrant: true },
    orderBy: [{ finalRank: "asc" }],
  });
  return results
    .filter((result) => result.status !== "REJECTED" && result.entrant.displayNameSnapshot && result.frozenCount > 0)
    .map((result) => ({
      entrantId: result.entrantId,
      userId: result.entrant.userId,
      displayName: result.entrant.displayNameSnapshot,
      entryStatus: result.entrant.status,
      verifiedCount: result.frozenCount,
      reviewableCount: 0,
      reachedCountAt: result.reachedCountAt,
      provisionalRank: result.finalRank,
      finalRank: result.finalRank,
      resultStatus: result.status,
    }));
}

module.exports = { compareRows, getContestStandings, getFinalStandings };
