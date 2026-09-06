const { prisma: defaultPrisma } = require("../../../db");
const { characterPresentation } = require("../../cosmetics");
const {
  safePublicDisplayName,
} = require("../../../shared/lib/displayNameValidator");

const publicProfileUserSelect = {
  id: true,
  displayName: true,
  profilePhotoUrl: true,
  isReviewAccount: true,
  equippedAccessories: {
    include: {
      shopItem: {
        select: {
          id: true,
          sku: true,
          name: true,
          slot: true,
          assetKey: true,
          renderMetadata: true,
          bobble: true,
          testOnly: true,
          remoteOnly: true,
          assetVersion: true,
        },
      },
    },
  },
};

function safeNonNegativeNumber(value) {
  const number = Number(value);
  return Number.isFinite(number) && number >= 0 ? number : 0;
}

function safeNonNegativeInteger(value) {
  return Math.max(0, Math.trunc(safeNonNegativeNumber(value)));
}

function buildPublicProfileStatsQuery(db, userId, today) {
  return db.$queryRaw`
    WITH placements AS (
      SELECT CASE
        WHEN r.is_team_race = TRUE AND r.winner_team IS NULL THEN NULL
        WHEN r.is_team_race = TRUE AND rp.team = r.winner_team THEN 1
        WHEN r.is_team_race = TRUE THEN 2
        ELSE rp.placement
      END AS effective_placement
      FROM race_participants rp
      JOIN races r ON r.id = rp.race_id
      WHERE rp.user_id = ${userId}
        AND rp.status = 'accepted'::"RaceParticipantStatus"
        AND rp.forfeited_at IS NULL
        AND r.status = 'completed'::"RaceStatus"
    ), race_stats AS (
      SELECT
        COUNT(*) FILTER (WHERE COALESCE(rp.raw_steps, 0) > 0)::bigint AS races_competed,
        COUNT(*) FILTER (
          WHERE COALESCE(rp.raw_steps, 0) > 0
            AND rp.forfeited_at IS NULL
            AND rp.placement = 1
            AND competitors.accepted_count >= 2
        )::bigint AS first_place_wins,
        COUNT(*) FILTER (
          WHERE COALESCE(rp.raw_steps, 0) > 0
            AND rp.forfeited_at IS NULL
            AND rp.placement BETWEEN 1 AND 3
            AND competitors.accepted_count >= 2
        )::bigint AS podium_finishes
      FROM race_participants rp
      JOIN races r ON r.id = rp.race_id
      JOIN LATERAL (
        SELECT COUNT(*)::integer AS accepted_count
        FROM race_participants competitor
        WHERE competitor.race_id = rp.race_id
          AND competitor.status = 'accepted'::"RaceParticipantStatus"
      ) competitors ON TRUE
      WHERE rp.user_id = ${userId}
        AND rp.status = 'accepted'::"RaceParticipantStatus"
        AND r.status = 'completed'::"RaceStatus"
        AND r.seed_id IS NULL
        AND r.seeded_bucket_id IS NULL
    )
    SELECT
      (SELECT COUNT(*) FROM placements WHERE effective_placement = 1)::bigint AS first_count,
      (SELECT COUNT(*) FROM placements WHERE effective_placement = 2)::bigint AS second_count,
      (SELECT COUNT(*) FROM placements WHERE effective_placement = 3)::bigint AS third_count,
      COALESCE(
        (SELECT ROUND(AVG(s.steps))::numeric FROM steps s WHERE s.user_id = ${userId} AND s.date <= ${today}::date),
        0
      ) AS avg_steps_per_day,
      race_stats.races_competed,
      race_stats.first_place_wins,
      race_stats.podium_finishes
    FROM race_stats
  `;
}

function buildGetPublicProfile(dependencies = {}) {
  const db = dependencies.prisma || defaultPrisma;

  return async function getPublicProfile({
    userId,
    supportsCharacters = false,
    releaseChannel = "prod",
    supportsRemoteAssets = false,
  }) {
    const user = await db.user.findFirst({
      where: {
        id: userId,
        // A display name is the existing social identity/discoverability gate.
        // Review accounts are never public to real users.
        displayName: { not: null },
        isReviewAccount: false,
      },
      select: publicProfileUserSelect,
    });
    if (!user || typeof user.displayName !== "string" || !user.displayName.trim()) return null;

    const today = new Date().toISOString().slice(0, 10);
    const [statsRow] = await buildPublicProfileStatsQuery(db, user.id, today);
    const racesCompeted = safeNonNegativeInteger(statsRow?.races_competed);
    const firstPlaceWins = safeNonNegativeInteger(statsRow?.first_place_wins);
    const { animal, accessories } = characterPresentation(
      user,
      supportsCharacters,
      releaseChannel,
      supportsRemoteAssets
    );

    return {
      contract: "public-profile-v1",
      user: {
        id: user.id,
        displayName: safePublicDisplayName(user.displayName),
        profilePhotoUrl: user.profilePhotoUrl ?? null,
        equippedAnimal: animal ?? null,
        equippedAccessories: Array.isArray(accessories) ? accessories : [],
      },
      stats: {
        racePodiums: {
          first: safeNonNegativeInteger(statsRow?.first_count),
          second: safeNonNegativeInteger(statsRow?.second_count),
          third: safeNonNegativeInteger(statsRow?.third_count),
        },
        avgStepsPerDay: safeNonNegativeNumber(statsRow?.avg_steps_per_day),
        racesCompeted,
        firstPlaceWins,
        podiumFinishes: safeNonNegativeInteger(statsRow?.podium_finishes),
        winRate:
          racesCompeted > 0
            ? Math.round((firstPlaceWins / racesCompeted) * 10_000) / 10_000
            : 0.0,
      },
    };
  };
}

const getPublicProfile = buildGetPublicProfile();

module.exports = {
  buildGetPublicProfile,
  getPublicProfile,
  publicProfileUserSelect,
};
