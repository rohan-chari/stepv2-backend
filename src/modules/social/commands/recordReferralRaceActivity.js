const crypto = require("node:crypto");
const { prisma } = require("../../../db");

// Stamp referral ownership at the ACCEPT transition. The INSERT ... SELECT is
// deliberately one idempotent statement so the activity commits or rolls back
// with the participant mutation and a transaction retry cannot duplicate it.
async function recordReferralRaceActivity({
  tx = prisma,
  raceParticipantId,
  refereeId,
  occurredAt,
}) {
  if (!tx || !raceParticipantId || !refereeId || !(occurredAt instanceof Date) ||
      Number.isNaN(occurredAt.getTime())) return null;

  const id = crypto.randomUUID();
  const rows = await tx.$queryRaw`
    INSERT INTO referral_race_activities (
      id,
      referral_id,
      referrer_id,
      race_participant_id,
      occurred_at,
      created_at
    )
    SELECT
      ${id},
      referral.id,
      referral.referrer_id,
      participant.id,
      ${occurredAt},
      CURRENT_TIMESTAMP
    FROM race_participants participant
    INNER JOIN races race
      ON race.id = participant.race_id
      AND race.seed_id IS NULL
      AND race.tournament_id IS NULL
    INNER JOIN referrals referral
      ON referral.referee_id = participant.user_id
      AND referral.referrer_id IS NOT NULL
      AND referral.created_at <= ${occurredAt}
    WHERE participant.id = ${raceParticipantId}
      AND participant.user_id = ${refereeId}
      AND participant.status = 'accepted'
    ON CONFLICT (race_participant_id) DO NOTHING
    RETURNING id, referral_id AS "referralId", referrer_id AS "referrerId"
  `;
  return rows[0] || null;
}

async function auditReferralRaceActivityCatchUp({ tx = prisma } = {}) {
  const [row] = await tx.$queryRaw`
    SELECT COUNT(*)::int AS "missingCount"
    FROM race_participants participant
    INNER JOIN races race
      ON race.id = participant.race_id
      AND race.seed_id IS NULL
      AND race.tournament_id IS NULL
    INNER JOIN referrals referral
      ON referral.referee_id = participant.user_id
      AND referral.referrer_id IS NOT NULL
      AND referral.created_at <= participant.joined_at
    LEFT JOIN referral_race_activities activity
      ON activity.race_participant_id = participant.id
    WHERE participant.status = 'accepted'
      AND activity.id IS NULL
  `;
  return Number(row?.missingCount || 0);
}

async function catchUpReferralRaceActivities({ tx = prisma } = {}) {
  return tx.$executeRaw`
    INSERT INTO referral_race_activities (
      id,
      referral_id,
      referrer_id,
      race_participant_id,
      occurred_at,
      created_at
    )
    SELECT
      gen_random_uuid()::text,
      referral.id,
      referral.referrer_id,
      participant.id,
      participant.joined_at,
      CURRENT_TIMESTAMP
    FROM race_participants participant
    INNER JOIN races race
      ON race.id = participant.race_id
      AND race.seed_id IS NULL
      AND race.tournament_id IS NULL
    INNER JOIN referrals referral
      ON referral.referee_id = participant.user_id
      AND referral.referrer_id IS NOT NULL
      AND referral.created_at <= participant.joined_at
    WHERE participant.status = 'accepted'
    ON CONFLICT (race_participant_id) DO NOTHING
  `;
}

module.exports = {
  auditReferralRaceActivityCatchUp,
  catchUpReferralRaceActivities,
  recordReferralRaceActivity,
};
