const { prisma } = require("../../../db");
const { validateDisplayName } = require("../../../shared/lib/displayNameValidator");

const SOURCE_LIMIT = 4;

function validPublicName(value) {
  const result = validateDisplayName(value);
  return result.isValid ? result.normalized : null;
}

function mergeCandidate(target, row) {
  if (!row?.id) return;
  const prior = target.get(row.id) || { id: row.id };
  target.set(row.id, {
    ...prior,
    ...row,
    raceJoinedAt: prior.raceJoinedAt && row.raceJoinedAt
      ? (new Date(prior.raceJoinedAt) > new Date(row.raceJoinedAt) ? prior.raceJoinedAt : row.raceJoinedAt)
      : (row.raceJoinedAt || prior.raceJoinedAt || null),
  });
}

function liveReferralCandidate(row, { includeFact = false } = {}) {
  const displayName = validPublicName(row?.referee?.displayName);
  if (!displayName) return null;
  return {
    id: row.id,
    referralFactId: includeFact ? row.id : null,
    displayName,
    attributedAt: row.createdAt,
    factStatus: includeFact ? row.status : null,
    qualifiedAt: includeFact ? row.qualifiedAt : null,
  };
}

// Referral ownership is stamped at the ACCEPT transition, so this reads the
// exact newest activity directly from a referrer/time index. Live joins enforce
// current privacy and race eligibility without scanning referral history.
async function getRecentRaceRows({ db, referrerId, windowStart, endsAt }) {
  return db.$queryRaw`
    SELECT
      activity.id AS "activityId",
      referral.id AS "referralId",
      referral.created_at AS "attributedAt",
      referee.display_name AS "displayName",
      activity.occurred_at AS "occurredAt"
    FROM referral_race_activities activity
    INNER JOIN referrals referral
      ON referral.id = activity.referral_id
    INNER JOIN users referee
      ON referee.id = referral.referee_id
      AND referee.is_review_account = FALSE
      AND referee.display_name IS NOT NULL
    INNER JOIN race_participants participant
      ON participant.id = activity.race_participant_id
      AND participant.user_id = referral.referee_id
      AND participant.status = 'accepted'
    INNER JOIN races race
      ON race.id = participant.race_id
      AND race.seed_id IS NULL
      AND race.tournament_id IS NULL
    WHERE activity.referrer_id = ${referrerId}
      AND activity.occurred_at >= ${windowStart}
      AND activity.occurred_at < ${endsAt}
      AND EXISTS (
        SELECT 1
        FROM race_participants opponent
        WHERE opponent.race_id = participant.race_id
          AND opponent.status = 'accepted'
          AND opponent.user_id <> participant.user_id
      )
    ORDER BY activity.occurred_at DESC, activity.id DESC
    LIMIT ${SOURCE_LIMIT}
  `;
}

async function getRecentGiveawayReferralCandidates({
  referrerId,
  startsAt,
  endsAt,
  acceptedAt,
  db = prisma,
}) {
  if (!referrerId || !(startsAt instanceof Date) || !(endsAt instanceof Date) ||
      !(acceptedAt instanceof Date)) return [];

  const windowStart = new Date(Math.max(startsAt.getTime(), acceptedAt.getTime()));
  const liveReferee = {
    isReviewAccount: false,
    displayName: { not: null },
  };
  const referralSelect = {
    id: true,
    status: true,
    createdAt: true,
    qualifiedAt: true,
    referee: { select: { displayName: true, isReviewAccount: true } },
  };

  const [signups, liveFacts, durableFacts, raceRows] = await Promise.all([
    db.referral.findMany({
      where: {
        referrerId,
        createdAt: { gte: windowStart, lt: endsAt },
        referee: { is: liveReferee },
      },
      select: referralSelect,
      orderBy: [{ createdAt: "desc" }, { id: "desc" }],
      take: SOURCE_LIMIT,
    }),
    db.referral.findMany({
      where: {
        referrerId,
        qualifiedAt: { gte: windowStart, lt: endsAt },
        referee: { is: liveReferee },
      },
      select: referralSelect,
      orderBy: [{ qualifiedAt: "desc" }, { id: "desc" }],
      take: SOURCE_LIMIT,
    }),
    db.referralQualificationFact.findMany({
      where: {
        referrerId,
        qualifiedAt: { gte: windowStart, lt: endsAt },
      },
      select: {
        referralFactId: true,
        status: true,
        qualifiedAt: true,
      },
      orderBy: [{ qualifiedAt: "desc" }, { referralFactId: "desc" }],
      take: SOURCE_LIMIT,
    }),
    getRecentRaceRows({ db, referrerId, windowStart, endsAt }),
  ]);

  const durableIds = durableFacts.map((fact) => fact.referralFactId);
  const durableLiveRows = durableIds.length === 0 ? [] : await db.referral.findMany({
    where: {
      id: { in: durableIds },
      referrerId,
      referee: { is: liveReferee },
    },
    select: referralSelect,
  });
  const durableLiveById = new Map(durableLiveRows.map((row) => [row.id, row]));

  const candidates = new Map();
  for (const row of signups) {
    const candidate = liveReferralCandidate(row);
    if (candidate) mergeCandidate(candidates, candidate);
  }
  for (const row of liveFacts) {
    const candidate = liveReferralCandidate(row, { includeFact: true });
    if (candidate) mergeCandidate(candidates, candidate);
  }
  for (const fact of durableFacts) {
    const live = durableLiveById.get(fact.referralFactId);
    const base = liveReferralCandidate(live);
    if (!base) continue;
    mergeCandidate(candidates, {
      ...base,
      referralFactId: fact.referralFactId,
      factStatus: fact.status,
      qualifiedAt: fact.qualifiedAt,
    });
  }
  for (const row of raceRows) {
    const displayName = validPublicName(row.displayName);
    if (!row.referralId || !displayName) continue;
    mergeCandidate(candidates, {
      id: row.referralId,
      stableEventId: row.activityId,
      displayName,
      attributedAt: row.attributedAt,
      raceJoinedAt: row.occurredAt,
    });
  }

  return [...candidates.values()];
}

module.exports = { getRecentGiveawayReferralCandidates };
