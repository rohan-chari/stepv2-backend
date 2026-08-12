const { prisma: defaultPrisma } = require("../../../db");

function buildSearchDiscoverableUsers(dependencies = {}) {
  const db = dependencies.prisma || defaultPrisma;

  return async function searchDiscoverableUsers({
    userId,
    handleQuery,
    discoverableQuery,
  }) {
    const handleContains = `%${handleQuery}%`;
    const handlePrefix = `${handleQuery}%`;
    const discoverableContains = `%${discoverableQuery}%`;
    const discoverablePrefix = `${discoverableQuery}%`;
    const rows = await db.$queryRaw`
      SELECT
        id,
        display_name AS "displayName",
        profile_photo_url AS "profilePhotoUrl",
        CASE
          WHEN name_setup_completed_at IS NOT NULL THEN
            concat_ws(' ', first_name, NULLIF(last_name, ''))
          ELSE NULL
        END AS "discoverableName"
      FROM users
      WHERE id <> ${userId}
        AND is_review_account = false
        AND (
          (display_name IS NOT NULL AND lower(display_name) LIKE ${handleContains})
          OR (
            name_setup_completed_at IS NOT NULL
            AND discoverable_name_search IS NOT NULL
            AND discoverable_name_search LIKE ${discoverableContains}
          )
        )
      ORDER BY
        CASE
          WHEN lower(display_name) = ${handleQuery} THEN 1
          WHEN name_setup_completed_at IS NOT NULL
            AND discoverable_name_search = ${discoverableQuery} THEN 2
          WHEN lower(display_name) LIKE ${handlePrefix} THEN 3
          WHEN name_setup_completed_at IS NOT NULL
            AND discoverable_name_search LIKE ${discoverablePrefix} THEN 4
          ELSE 5
        END,
        lower(display_name) NULLS LAST,
        id
      LIMIT 20
    `;
    return rows.map((row) => ({
      id: row.id,
      displayName: row.displayName ?? null,
      profilePhotoUrl: row.profilePhotoUrl ?? null,
      ...(row.discoverableName
        ? { discoverableName: row.discoverableName }
        : {}),
    }));
  };
}

const searchDiscoverableUsers = buildSearchDiscoverableUsers();

module.exports = { buildSearchDiscoverableUsers, searchDiscoverableUsers };
