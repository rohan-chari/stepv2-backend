const { prisma } = require("../../../db");

async function auditGiveawayPointReviewOwnership({ tx = prisma } = {}) {
  const [row] = await tx.$queryRaw`
    SELECT COUNT(*)::int AS "missingCount"
    FROM giveaway_point_reviews review
    WHERE review.referrer_id_snapshot IS NULL
      AND (
        EXISTS (
          SELECT 1
          FROM referral_qualification_facts fact
          WHERE fact.referral_fact_id = review.referral_fact_id
            AND fact.referrer_id IS NOT NULL
        )
        OR EXISTS (
          SELECT 1
          FROM referrals referral
          WHERE referral.id = review.referral_fact_id
            AND referral.referrer_id IS NOT NULL
            AND referral.qualified_at IS NOT NULL
            AND referral.status IN ('FLAGGED', 'QUALIFIED', 'REWARDED')
        )
      )
  `;
  return Number(row?.missingCount || 0);
}

async function catchUpGiveawayPointReviewOwnership({ tx = prisma } = {}) {
  const durable = await tx.$executeRaw`
    UPDATE giveaway_point_reviews review
    SET referrer_id_snapshot = fact.referrer_id
    FROM referral_qualification_facts fact
    WHERE review.referrer_id_snapshot IS NULL
      AND fact.referral_fact_id = review.referral_fact_id
      AND fact.referrer_id IS NOT NULL
  `;
  const liveFallback = await tx.$executeRaw`
    UPDATE giveaway_point_reviews review
    SET referrer_id_snapshot = referral.referrer_id
    FROM referrals referral
    WHERE review.referrer_id_snapshot IS NULL
      AND referral.id = review.referral_fact_id
      AND referral.referrer_id IS NOT NULL
      AND referral.qualified_at IS NOT NULL
      AND referral.status IN ('FLAGGED', 'QUALIFIED', 'REWARDED')
  `;
  return Number(durable) + Number(liveFallback);
}

module.exports = {
  auditGiveawayPointReviewOwnership,
  catchUpGiveawayPointReviewOwnership,
};
