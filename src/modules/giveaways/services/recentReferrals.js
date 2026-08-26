const { iso } = require("../models/contest");
const { classifyReferralFact } = require("../models/referralFactState");
const { validateDisplayName } = require("../../../shared/lib/displayNameValidator");

const REVIEW_SOURCE_LIMIT = 4;

async function getRecentPointReviewCandidates({
  db,
  contestId,
  referrerId,
  startsAt,
  endsAt,
  acceptedAt,
}) {
  if (!db || !contestId || !referrerId || !(startsAt instanceof Date) ||
      !(endsAt instanceof Date) || !(acceptedAt instanceof Date)) {
    return { candidates: [], reviews: [] };
  }
  const windowStart = new Date(Math.max(startsAt.getTime(), acceptedAt.getTime()));
  const rows = await db.$queryRaw`
    SELECT
      review.referral_fact_id AS "referralFactId",
      review.decision,
      review.decided_at AS "decidedAt",
      referral.id AS "referralId",
      referral.created_at AS "attributedAt",
      COALESCE(fact.status, referral.status) AS "factStatus",
      COALESCE(fact.qualified_at, referral.qualified_at) AS "qualifiedAt",
      referee.display_name AS "displayName"
    FROM giveaway_point_reviews review
    INNER JOIN giveaway_entrants entrant
      ON entrant.contest_id = review.contest_id
      AND entrant.user_id = review.referrer_id_snapshot
      AND entrant.status IN ('ELIGIBLE', 'UNDER_REVIEW')
    LEFT JOIN referral_qualification_facts fact
      ON fact.referral_fact_id = review.referral_fact_id
    INNER JOIN referrals referral
      ON referral.id = review.referral_fact_id
    INNER JOIN users referee
      ON referee.id = referral.referee_id
      AND referee.is_review_account = FALSE
      AND referee.display_name IS NOT NULL
    WHERE review.contest_id = ${contestId}
      AND review.referrer_id_snapshot = ${referrerId}
      AND review.decision IN ('APPROVE', 'REJECT')
      AND COALESCE(fact.qualified_at, referral.qualified_at) >= ${windowStart}
      AND COALESCE(fact.qualified_at, referral.qualified_at) < ${endsAt}
      AND (
        fact.referral_fact_id IS NOT NULL
        OR (
          referral.qualified_at IS NOT NULL
          AND referral.status IN ('FLAGGED', 'QUALIFIED', 'REWARDED')
        )
      )
    ORDER BY review.decided_at DESC, review.id DESC
    LIMIT ${REVIEW_SOURCE_LIMIT}
  `;

  const visible = rows.flatMap((row) => {
    const name = validateDisplayName(row.displayName);
    if (!name.isValid) return [];
    return [{ ...row, displayName: name.normalized }];
  });
  return {
    candidates: visible.map((row) => ({
      id: row.referralId,
      referralFactId: row.referralFactId,
      displayName: row.displayName,
      attributedAt: row.attributedAt,
      factStatus: row.factStatus,
      qualifiedAt: row.qualifiedAt,
    })),
    reviews: visible.map((row) => ({
      referralFactId: row.referralFactId,
      decision: row.decision,
      decidedAt: row.decidedAt,
    })),
  };
}

function publicState(candidate, review) {
  const factState = classifyReferralFact({ status: candidate.factStatus }, review);
  if (factState === "REJECTED") {
    return { status: "NOT_COUNTED", occurredAt: review.decidedAt };
  }
  if (factState === "VERIFIED") {
    return { status: "QUALIFIED", occurredAt: candidate.qualifiedAt };
  }
  if (factState === "REVIEWABLE") {
    return { status: "UNDER_REVIEW", occurredAt: candidate.qualifiedAt };
  }
  if (candidate.raceJoinedAt) {
    return { status: "IN_RACE", occurredAt: candidate.raceJoinedAt };
  }
  return { status: "SIGNED_UP", occurredAt: candidate.attributedAt };
}

function buildRecentReferrals(candidates, reviews, limit = 4) {
  const reviewByFact = new Map((Array.isArray(reviews) ? reviews : [])
    .map((review) => [review.referralFactId, review]));

  return (Array.isArray(candidates) ? candidates : [])
    .flatMap((candidate) => {
      if (!candidate || typeof candidate.displayName !== "string" || !candidate.displayName.trim()) {
        return [];
      }
      const state = publicState(candidate, reviewByFact.get(candidate.referralFactId));
      const occurredAt = iso(state.occurredAt);
      if (!occurredAt) return [];
      return [{
        _stableId: String(candidate.stableEventId || candidate.id || ""),
        displayName: candidate.displayName.trim(),
        occurredAt,
        status: state.status,
      }];
    })
    .sort((left, right) => new Date(right.occurredAt) - new Date(left.occurredAt) ||
      right._stableId.localeCompare(left._stableId))
    .slice(0, limit)
    .map(({ _stableId: _omitted, ...row }) => row);
}

module.exports = { buildRecentReferrals, getRecentPointReviewCandidates, publicState };
