const { Prisma } = require("@prisma/client");

async function findLegacyPublicRaceCandidates({ prisma, userId }) {
  const rows = await prisma.$queryRaw(Prisma.sql`
    WITH candidates AS MATERIALIZED (
      SELECT r.id, r.name, r.ends_at, r.max_participants, r.seed_id, r.started_at
      FROM races r
      JOIN users creator ON creator.id = r.creator_id
      WHERE r.status = 'active'::"RaceStatus" AND r.is_public = TRUE
        AND creator.is_review_account = FALSE
        AND NOT EXISTS (
          SELECT 1 FROM race_participants mine
          WHERE mine.race_id = r.id AND mine.user_id = ${userId}
            AND mine.status IN ('accepted'::"RaceParticipantStatus", 'invited'::"RaceParticipantStatus")
        )
      ORDER BY r.started_at ASC
      LIMIT 25
    )
    SELECT c.id, c.name, c.ends_at AS "endsAt", c.max_participants AS "maxParticipants",
      seed.kind AS "seedKind", COALESCE(parts.accepted_count, 0)::int AS "participantCount"
    FROM candidates c
    LEFT JOIN race_seeds seed ON seed.id = c.seed_id
    LEFT JOIN LATERAL (
      SELECT COUNT(*)::int AS accepted_count FROM race_participants rp
      WHERE rp.race_id = c.id AND rp.status = 'accepted'::"RaceParticipantStatus"
    ) parts ON TRUE
    ORDER BY c.started_at ASC
  `);
  return rows.map((row) => ({ ...row, participantCount: Number(row.participantCount || 0) }));
}

async function findNextRaceCandidates({ prisma, userId, now }) {
  const activeCutoff = new Date(now.getTime() - 24 * 60 * 60 * 1000);
  const rows = await prisma.$queryRaw(Prisma.sql`
    WITH candidates AS MATERIALIZED (
      SELECT r.id, r.name, r.status, r.started_at, r.ends_at, r.max_participants,
        r.is_team_race, r.created_at, r.creator_id
      FROM races r
      JOIN users creator ON creator.id = r.creator_id
      WHERE r.status IN ('pending'::"RaceStatus", 'active'::"RaceStatus")
        AND r.is_public = TRUE AND creator.is_review_account = FALSE
        AND r.buy_in_amount = 0 AND r.is_team_race = FALSE
        AND NOT EXISTS (
          SELECT 1 FROM race_participants mine
          WHERE mine.race_id = r.id AND mine.user_id = ${userId}
            AND mine.status <> 'declined'::"RaceParticipantStatus"
        )
        AND ((r.status = 'pending'::"RaceStatus" AND r.start_policy = 'ON_MINIMUM_PARTICIPANTS')
          OR (r.status = 'active'::"RaceStatus" AND r.started_at >= ${activeCutoff} AND r.ends_at > ${now}))
      ORDER BY r.created_at DESC
      LIMIT 24
    )
    SELECT c.id, c.name, UPPER(c.status::text) AS status,
      c.started_at AS "startedAt", c.ends_at AS "endsAt",
      c.max_participants AS "maxParticipants", c.is_team_race AS "isTeamRace",
      c.created_at AS "createdAt", c.creator_id AS "creatorId",
      creator.display_name AS "creatorDisplayName", creator.profile_photo_url AS "creatorProfilePhotoUrl",
      COALESCE(parts.accepted_count, 0)::int AS "participantCount"
    FROM candidates c
    JOIN users creator ON creator.id = c.creator_id
    LEFT JOIN LATERAL (
      SELECT COUNT(*)::int AS accepted_count FROM race_participants rp
      WHERE rp.race_id = c.id AND rp.status = 'accepted'::"RaceParticipantStatus"
    ) parts ON TRUE
    ORDER BY c.created_at DESC
  `);
  return rows.map((row) => ({
    id: row.id, name: row.name, status: row.status, startedAt: row.startedAt,
    endsAt: row.endsAt, maxParticipants: row.maxParticipants, isTeamRace: row.isTeamRace,
    createdAt: row.createdAt, creatorId: row.creatorId,
    creator: { id: row.creatorId, displayName: row.creatorDisplayName,
      profilePhotoUrl: row.creatorProfilePhotoUrl },
    participantCount: Number(row.participantCount || 0),
  }));
}

module.exports = { findLegacyPublicRaceCandidates, findNextRaceCandidates };
