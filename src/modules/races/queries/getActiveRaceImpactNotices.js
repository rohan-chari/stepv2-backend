const {
  RaceImpactEvent: defaultModel,
  isValidEvent,
  popupProjection,
} = require("../models/raceImpactEvent");
const { NotFoundError, ForbiddenError } = require("../../../shared/errors/AppError");

function buildGetActiveRaceImpactNotices(dependencies = {}) {
  const model = dependencies.RaceImpactEvent || defaultModel;

  return async function getActiveRaceImpactNotices({ raceId, userId }) {
    const race = await model.getRaceAccess({ raceId, userId });
    if (!race) throw new NotFoundError("Race not found", "NOT_FOUND");
    if (!Array.isArray(race.participants) || race.participants.length === 0) {
      throw new ForbiddenError(
        "You are not a participant in this race",
        "FORBIDDEN",
      );
    }
    if (race.status !== "ACTIVE") return { notices: [] };

    const rows = await model.listUnacknowledged({ raceId, userId, limit: 20 });
    return {
      notices: (rows || [])
        .filter(isValidEvent)
        .map(popupProjection)
        .filter(Boolean),
    };
  };
}

const getActiveRaceImpactNotices = buildGetActiveRaceImpactNotices();

module.exports = {
  isValidNotice: isValidEvent,
  buildGetActiveRaceImpactNotices,
  getActiveRaceImpactNotices,
};
