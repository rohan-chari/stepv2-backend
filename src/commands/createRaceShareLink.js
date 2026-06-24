const { Race } = require("../models/race");
const { generateShareToken } = require("../utils/shareToken");

class RaceShareLinkError extends Error {
  constructor(message, statusCode) {
    super(message);
    this.name = "RaceShareLinkError";
    if (statusCode) this.statusCode = statusCode;
  }
}

// Mints (or returns the existing) shareable token for a race. Any ACCEPTED
// participant may share — this is a social app, not just the host — but a
// stranger or a not-yet-accepted invitee may not (prevents enumeration of
// private races by anyone who merely knows a race id).
//
// Idempotent: a race has at most one share token for its lifetime, so repeated
// shares return the same link (and don't churn the DB). The token is opaque, so
// reusing it leaks nothing the first link didn't already.
function buildCreateRaceShareLink(dependencies = {}) {
  const raceModel = dependencies.Race || Race;
  const mintToken = dependencies.generateShareToken || generateShareToken;

  return async function createRaceShareLink({ userId, raceId }) {
    const race = await raceModel.findById(raceId);
    if (!race) {
      throw new RaceShareLinkError("Race not found", 404);
    }

    const isAcceptedMember =
      Array.isArray(race.participants) &&
      race.participants.some(
        (p) => p.userId === userId && p.status === "ACCEPTED"
      );
    if (!isAcceptedMember) {
      throw new RaceShareLinkError(
        "Only a participant can share this race",
        403
      );
    }

    if (race.shareToken) {
      return { shareToken: race.shareToken };
    }

    const shareToken = mintToken();
    await raceModel.update(raceId, { shareToken });
    return { shareToken };
  };
}

const createRaceShareLink = buildCreateRaceShareLink();

module.exports = {
  buildCreateRaceShareLink,
  createRaceShareLink,
  RaceShareLinkError,
};
