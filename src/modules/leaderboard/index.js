// Public interface of the leaderboard module (audit Phase 9a — first module
// move). Other code imports ONLY from here; getLeaderboard and
// recordLeaderboardRankings are module-private.
const { createLeaderboardRouter } = require("./routes");

module.exports = { createLeaderboardRouter };
