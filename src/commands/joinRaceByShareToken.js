const { Race } = require("../models/race");
const { withRaceJoinLock } = require("../services/raceJoinLock");
const { buildJoinRaceCore } = require("./joinRaceCore");

// Thrown only for the share-token-specific failure: the token resolves to no
// race (unknown/revoked link). All other join failures (full, already joined,
// closed, can't afford) surface as RaceJoinError from the shared core.
class RaceShareJoinError extends Error {
  constructor(message, statusCode) {
    super(message);
    this.name = "RaceShareJoinError";
    if (statusCode) this.statusCode = statusCode;
  }
}

// Link-join: a user joins via a shareable race link (https://<host>/r/<token>).
// Possession of the unguessable token IS the invitation, so this path
// deliberately does NOT enforce `isPublic` — private/friends races are joinable
// by anyone holding the link. Everything else (status/capacity/buy-in/boxes) is
// the exact same logic as browse-join, via the shared core.
function buildJoinRaceByShareToken(dependencies = {}) {
  const raceModel = dependencies.Race || Race;
  const withLock = dependencies.withRaceJoinLock || withRaceJoinLock;
  const joinRaceCore = buildJoinRaceCore(dependencies);

  return async function joinRaceByShareToken({ userId, token, onboarding }) {
    // Resolve the token -> race OUTSIDE the lock (the lock is keyed by race id,
    // which we don't have until the token is resolved). An unknown token never
    // acquires a lock.
    const resolved = await raceModel.findByShareToken(token);
    if (!resolved) {
      throw new RaceShareJoinError("Race not found", 404);
    }

    return withLock(resolved.id, async () => {
      // Re-read inside the lock for a fresh participant set, so concurrent joins
      // can't both slip past the capacity check (mirrors joinPublicRace).
      const race = await raceModel.findById(resolved.id);
      if (!race) {
        throw new RaceShareJoinError("Race not found", 404);
      }

      return joinRaceCore({ race, userId, onboarding });
    });
  };
}

const joinRaceByShareToken = buildJoinRaceByShareToken();

module.exports = {
  buildJoinRaceByShareToken,
  joinRaceByShareToken,
  RaceShareJoinError,
};
