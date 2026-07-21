// Public interface of the ranked module (audit Phase 9f). getRanked (v1) is
// old-client compat for shipped binaries < 1.3.0 — it moves with the module
// but is never deleted (frozen-old-client rule). Season/SeasonScore are
// exported for the one sanctioned inbound edge (modules/steps routes/steps.js reads the
// viewer's active season score).
const { createRankedRouter } = require("./routes");
const { scheduleComputeRanks } = require("./jobs/computeRanks");
const { scheduleComputeRankedWeeks } = require("./jobs/computeRankedWeeks");
const { Season, SeasonScore } = require("./models/season");

module.exports = {
  createRankedRouter,
  scheduleComputeRanks,
  scheduleComputeRankedWeeks,
  Season,
  SeasonScore,
};
