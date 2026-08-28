const { RaceParticipant: defaultRaceParticipant } = require("../models/raceParticipant");
const { invalidateUser: defaultInvalidateUser } = require("../services/raceListCache");
const { NotFoundError, ValidationError } = require("../../../shared/errors/AppError");

function buildSetRaceFavorite(dependencies = {}) {
  const RaceParticipant = dependencies.RaceParticipant || defaultRaceParticipant;
  const invalidateUser = dependencies.invalidateRaceListUser || defaultInvalidateUser;
  const now = dependencies.now || (() => new Date());
  const logger = dependencies.logger || console;

  return async function setRaceFavorite({ raceId, userId, favorite }) {
    if (typeof favorite !== "boolean") {
      throw new ValidationError("favorite must be boolean", "INVALID_FAVORITE");
    }
    const row = await RaceParticipant.setFavorite({ raceId, userId, favorite, now: now() });
    if (!row) throw new NotFoundError("Race not found", "RACE_NOT_FOUND");
    try {
      await invalidateUser(userId);
    } catch (error) {
      logger.error?.("Race favorite cache invalidation failed", {
        userId,
        raceId,
        error: error instanceof Error ? error.message : String(error),
      });
    }
    return {
      raceId: row.raceId,
      isFavorite: row.favoritedAt instanceof Date,
      favoritedAt: row.favoritedAt,
    };
  };
}

const setRaceFavorite = buildSetRaceFavorite();

module.exports = { buildSetRaceFavorite, setRaceFavorite };
