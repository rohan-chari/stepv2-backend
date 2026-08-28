const { prisma: defaultPrisma } = require("../../../db");
const {
  ACTIVE_COMPETITION_LIMIT_KEY,
  ACTIVE_COMPETITION_LIMIT_DEFAULT,
  ACTIVE_COMPETITION_LIMIT_MINIMUM,
  ACTIVE_COMPETITION_LIMIT_MAXIMUM,
} = require("../../../shared/config/appSettings");

function validLimit(value) {
  return Number.isInteger(value) &&
    value >= ACTIVE_COMPETITION_LIMIT_MINIMUM &&
    value <= ACTIVE_COMPETITION_LIMIT_MAXIMUM;
}

function buildGetActiveCompetitionLimit(dependencies = {}) {
  const prisma = dependencies.prisma || defaultPrisma;
  return async function getActiveCompetitionLimit() {
    try {
      const row = await prisma.appSetting.findUnique({
        where: { key: ACTIVE_COMPETITION_LIMIT_KEY },
      });
      return {
        activeCompetitionLimit: validLimit(row?.value)
          ? row.value
          : ACTIVE_COMPETITION_LIMIT_DEFAULT,
        minimum: ACTIVE_COMPETITION_LIMIT_MINIMUM,
        maximum: ACTIVE_COMPETITION_LIMIT_MAXIMUM,
        updatedAt: validLimit(row?.value) ? row.updatedAt : null,
      };
    } catch {
      return {
        activeCompetitionLimit: ACTIVE_COMPETITION_LIMIT_DEFAULT,
        minimum: ACTIVE_COMPETITION_LIMIT_MINIMUM,
        maximum: ACTIVE_COMPETITION_LIMIT_MAXIMUM,
        updatedAt: null,
      };
    }
  };
}

const getActiveCompetitionLimit = buildGetActiveCompetitionLimit();

module.exports = { buildGetActiveCompetitionLimit, getActiveCompetitionLimit };
