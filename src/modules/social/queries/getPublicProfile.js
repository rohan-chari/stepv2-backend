const { prisma: defaultPrisma } = require("../../../db");
const { characterPresentation } = require("../../cosmetics");

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
    )
    SELECT
      (SELECT COUNT(*) FROM placements WHERE effective_placement = 1)::bigint AS first_count,
      (SELECT COUNT(*) FROM placements WHERE effective_placement = 2)::bigint AS second_count,
      (SELECT COUNT(*) FROM placements WHERE effective_placement = 3)::bigint AS third_count,
      COALESCE(
        (SELECT ROUND(AVG(s.steps))::numeric FROM steps s WHERE s.user_id = ${userId} AND s.date <= ${today}::date),
        0
      ) AS avg_steps_per_day
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
        displayName: user.displayName ?? null,
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
