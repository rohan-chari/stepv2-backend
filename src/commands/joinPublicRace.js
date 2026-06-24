const { Race } = require("../models/race");
const { withRaceJoinLock } = require("../services/raceJoinLock");
const { buildJoinRaceCore, RaceJoinError } = require("./joinRaceCore");

// Browse-join: a user joins a PUBLIC race they found in the public races list.
// Resolves the race by id, enforces the `isPublic` gate, then defers to the
// shared join core for the status/duplicate/capacity/buy-in/participant/box
// logic. Re-exports RaceJoinError so existing callers/tests keep importing it
// from here unchanged.
function buildJoinPublicRace(dependencies = {}) {
  const raceModel = dependencies.Race || Race;
  const withLock = dependencies.withRaceJoinLock || withRaceJoinLock;
  const joinRaceCore = buildJoinRaceCore(dependencies);

  return async function joinPublicRace({ userId, raceId, onboarding }) {
    return withLock(raceId, async () => {
      const race = await raceModel.findById(raceId);
      if (!race) {
        throw new RaceJoinError("Race not found", 404);
      }
      if (!race.isPublic) {
        throw new RaceJoinError("This race is not public", 403);
      }

      return joinRaceCore({ race, userId, onboarding });
    });
  };
}

const joinPublicRace = buildJoinPublicRace();

module.exports = { buildJoinPublicRace, joinPublicRace, RaceJoinError };
