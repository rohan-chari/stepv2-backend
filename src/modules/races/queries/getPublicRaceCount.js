const { Race } = require("../models/race");
const { isVisiblePublicRace } = require("./getPublicRaces");
const { appSettings: defaultAppSettings } = require("../../../shared/config/appSettings");
const { isStrictFlagEnabled } = require("../../../shared/config/isStrictFlagEnabled");

// Count of browsable public races for the viewer, applying the SAME visibility,
// membership, capacity, seed, and team-race rules as getPublicRaces but without
// serializing race cards (§6.2 publicRaceCount). Uses the lean
// findPublicPendingLean fetch (same where clause + participant subset the
// predicate reads) so the count always equals getPublicRaces(...).length.
function buildGetPublicRaceCount(dependencies = {}) {
  const raceModel = dependencies.Race || Race;
  const settings = dependencies.appSettings || defaultAppSettings;

  return async function getPublicRaceCount({
    userId,
    supportsTeamRaces = false,
    excludeSeeded = false,
    hiddenSeededWindows = [],
  }) {
    let sqlEnabled = false;
    if (dependencies.publicRaceCountSqlV1Enabled != null) {
      sqlEnabled = dependencies.publicRaceCountSqlV1Enabled === true;
    } else if (!dependencies.Race || dependencies.appSettings) {
      sqlEnabled = await isStrictFlagEnabled(
        settings,
        "publicRaceCountSqlV1Enabled"
      );
    }
    if (sqlEnabled && typeof raceModel.countVisiblePublicRaces === "function") {
      return raceModel.countVisiblePublicRaces({
        userId,
        supportsTeamRaces,
        excludeSeeded,
        hiddenSeededWindows,
      });
    }
    const hiddenWindows = new Set(hiddenSeededWindows.map(
      (row) => `${row.seedId}:${new Date(row.windowStart).toISOString()}`
    ));
    const races = await raceModel.findPublicPendingLean({ excludeSeeded });
    let count = 0;
    for (const race of races) {
      if (race.seedId && hiddenWindows.has(`${race.seedId}:${new Date(race.scheduledStartAt || race.startedAt).toISOString()}`)) continue;
      if (isVisiblePublicRace(race, userId, supportsTeamRaces)) count += 1;
    }
    return count;
  };
}

const getPublicRaceCount = buildGetPublicRaceCount();

module.exports = { buildGetPublicRaceCount, getPublicRaceCount };
