const { Race } = require("../models/race");
const { loadRaceParticipantReadSummary } = require("./raceParticipantReadSummary");

// Request-owned loader slots. A viewer-only participant list is never passed
// through the historical full-race preload contract.
function createRaceBootstrapReadContext({ race, userId }) {
  if (race?._bootstrapReadViewer !== userId) return null;
  let summaryPromise, fullPromise;
  return Object.freeze({
    matches: (raceId, viewerId) => race.id === raceId && userId === viewerId,
    core: () => race,
    summary: () => summaryPromise ??= loadRaceParticipantReadSummary(race.id).catch((error) => {
      // A transient progress read failure must not pin a rejected promise for
      // the independent details fallback later in this same request.
      summaryPromise = null;
      throw error;
    }),
    fullScoringContext: () => fullPromise ??= Race.findProgressScoringContext(race.id),
  });
}

module.exports = { createRaceBootstrapReadContext };
