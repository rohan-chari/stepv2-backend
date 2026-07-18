const { Race } = require("../models/race");
const { isVisiblePublicRace } = require("./getPublicRaces");

// Count of browsable public races for the viewer, applying the SAME visibility,
// membership, capacity, seed, and team-race rules as getPublicRaces but without
// serializing race cards (§6.2 publicRaceCount). Uses the lean
// findPublicPendingLean fetch (same where clause + participant subset the
// predicate reads) so the count always equals getPublicRaces(...).length.
function buildGetPublicRaceCount(dependencies = {}) {
  const raceModel = dependencies.Race || Race;

  return async function getPublicRaceCount({ userId, supportsTeamRaces = false }) {
    const races = await raceModel.findPublicPendingLean();
    let count = 0;
    for (const race of races) {
      if (isVisiblePublicRace(race, userId, supportsTeamRaces)) count += 1;
    }
    return count;
  };
}

const getPublicRaceCount = buildGetPublicRaceCount();

module.exports = { buildGetPublicRaceCount, getPublicRaceCount };
