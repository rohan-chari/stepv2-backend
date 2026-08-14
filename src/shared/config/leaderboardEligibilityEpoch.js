const { prisma: defaultPrisma } = require("../../db");

const KEY = "leaderboardEligibilityEpoch";

function buildLeaderboardEligibilityEpoch(dependencies = {}) {
  const prisma = dependencies.prisma || defaultPrisma;

  async function get() {
    const row = await prisma.appSetting.findUnique({ where: { key: KEY } });
    const value = row?.value;
    return Number.isSafeInteger(value) && value >= 0 ? value : 0;
  }

  async function advance(tx = prisma) {
    const rows = await tx.$queryRaw`
      INSERT INTO app_settings (key, value)
      VALUES (${KEY}, to_jsonb(1))
      ON CONFLICT (key) DO UPDATE SET value = to_jsonb(
        CASE
          WHEN jsonb_typeof(app_settings.value) = 'number'
            AND (app_settings.value #>> '{}') ~ '^[0-9]+$'
          THEN (app_settings.value #>> '{}')::bigint + 1
          ELSE 1
        END
      )
      RETURNING value
    `;
    const value = rows?.[0]?.value;
    return Number.isSafeInteger(value) ? value : Number(value);
  }

  return { get, advance, KEY };
}

const leaderboardEligibilityEpoch = buildLeaderboardEligibilityEpoch();
module.exports = { buildLeaderboardEligibilityEpoch, leaderboardEligibilityEpoch, KEY };
