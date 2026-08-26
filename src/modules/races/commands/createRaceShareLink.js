const { Race } = require("../models/race");
const { generateShareToken } = require("../../../shared/lib/shareToken");
const {
  assertAcceptedParticipant,
  assertFound,
  reuseOrMintShareToken,
} = require("../../../shared/competition/lifecycle");
const { RaceShareLink } = require("../models/raceShareLink");

const CAPABLE_LINK_TTL_MS = 30 * 24 * 60 * 60 * 1000;

class RaceShareLinkError extends Error {
  constructor(message, statusCode, code) {
    super(message);
    this.name = "RaceShareLinkError";
    if (statusCode) this.statusCode = statusCode;
    if (code) this.code = code;
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
  const raceShareLinkModel = dependencies.RaceShareLink || RaceShareLink;
  const mintToken = dependencies.generateShareToken || generateShareToken;

  return async function createRaceShareLink({ userId, raceId, clientFeatures = null, now = new Date() }) {
    const race = assertFound(
      await raceModel.findById(raceId),
      () => new RaceShareLinkError("Race not found", 404)
    );
    if (race.tournamentId) {
      throw new RaceShareLinkError(
        "This race is managed by its tournament",
        400,
        "TOURNAMENT_RACE_LOCKED"
      );
    }
    if (race.seededBucketId) {
      throw new RaceShareLinkError("This seeded race is private", 403, "RACE_PRIVATE");
    }

    assertAcceptedParticipant(
      race,
      userId,
      () => new RaceShareLinkError("Only a participant can share this race", 403)
    );

    const supportsApproval =
      clientFeatures?.has?.("privatejoinapproval") === true;
    if (supportsApproval && race.isPublic !== true) {
      const rawToken = mintToken();
      const sharer = race.participants.find(
        (participant) => participant.userId === userId,
      );
      const expiresAt = new Date(now.getTime() + CAPABLE_LINK_TTL_MS);
      await raceShareLinkModel.create({
        raceId,
        sharedByUserId: userId,
        sharedByDisplayName: sharer?.user?.displayName ?? null,
        rawToken,
        expiresAt,
      });
      return {
        shareToken: rawToken,
        approvalRequired: true,
        expiresAt,
      };
    }

    return reuseOrMintShareToken({
      entity: race,
      mintToken,
      persist: (shareToken) => raceModel.update(raceId, { shareToken }),
    });
  };
}

const createRaceShareLink = buildCreateRaceShareLink();

module.exports = {
  buildCreateRaceShareLink,
  createRaceShareLink,
  RaceShareLinkError,
  CAPABLE_LINK_TTL_MS,
};
