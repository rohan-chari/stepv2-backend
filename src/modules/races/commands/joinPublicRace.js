const { Race } = require("../models/race");
const { withRaceJoinLock } = require("../services/raceJoinLock");
const { buildJoinRaceCore, RaceJoinError } = require("./joinRaceCore");
const {
  buildMaybeAutoStartPrivateRace,
} = require("../jobs/privateRaceAutoStart");

// Browse-join: a user joins a PUBLIC race they found in the public races list.
// Resolves the race by id, enforces the `isPublic` gate, then defers to the
// shared join core for the status/duplicate/capacity/buy-in/participant/box
// logic. Re-exports RaceJoinError so existing callers/tests keep importing it
// from here unchanged.
function buildJoinPublicRace(dependencies = {}) {
  const raceModel = dependencies.Race || Race;
  const withLock = dependencies.withRaceJoinLock || withRaceJoinLock;
  const joinRaceCore = buildJoinRaceCore(dependencies);
  // Batch 2026-08-08 item 2 — private-race auto-start hook. A no-op on this
  // path by construction (the isPublic gate above means the predicate always
  // rejects), but wired for symmetry with the other join entry points so the
  // rule lives in exactly one place.
  const maybeAutoStartPrivateRace =
    dependencies.maybeAutoStartPrivateRace ||
    buildMaybeAutoStartPrivateRace(dependencies);

  // `team` + `clientFeatures` thread through to the shared core for team races
  // (TR-201/202/204/703); both are ignored on individual races.
  return async function joinPublicRace({
    userId,
    raceId,
    onboarding,
    team = null,
    clientFeatures = null,
  }) {
    const participant = await withLock(raceId, async () => {
      const race = await raceModel.findById(raceId);
      if (!race) {
        throw new RaceJoinError("Race not found", 404, "RACE_NOT_FOUND");
      }
      if (race.tournamentId) {
        throw new RaceJoinError(
          "This race is managed by its tournament",
          400,
          "TOURNAMENT_RACE_LOCKED"
        );
      }
      if (!race.isPublic) {
        throw new RaceJoinError("This race is not public", 403);
      }

      return joinRaceCore({ race, userId, onboarding, team, clientFeatures });
    });

    // OUTSIDE the advisory lock, after the participant row has committed.
    // startRace does per-participant step lookups + updates + push fan-out;
    // holding the join lock across that is the 3e6c827 pool-exhaustion shape.
    await maybeAutoStartPrivateRace({ raceId });

    return participant;
  };
}

const joinPublicRace = buildJoinPublicRace();

module.exports = { buildJoinPublicRace, joinPublicRace, RaceJoinError };
