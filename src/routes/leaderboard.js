const { Router } = require("express");
const { buildRequireAuth } = require("../middleware/requireAuth");
const { getLeaderboard: defaultGetLeaderboard } = require("../queries/getLeaderboard");

const VALID_PERIODS = ["today", "week", "month", "allTime"];

function createLeaderboardRouter(dependencies = {}) {
  const router = Router();
  const requireAuth =
    dependencies.requireAuth || buildRequireAuth(dependencies);
  const getLeaderboard = dependencies.getLeaderboard || defaultGetLeaderboard;

  router.use(requireAuth);

  // GET /leaderboard?period=today|week|month|allTime
  router.get("/", async (req, res) => {
    try {
      const period = req.query.period || "today";

      if (!VALID_PERIODS.includes(period)) {
        return res.status(400).json({
          error: `Invalid period. Must be one of: ${VALID_PERIODS.join(", ")}`,
        });
      }

      const result = await getLeaderboard(period, req.user.id, req.timeZone);
      res.json(result);
    } catch (error) {
      console.error("Leaderboard error:", error);
      res.status(500).json({ error: "Internal server error" });
    }
  });

  return router;
}

module.exports = { createLeaderboardRouter };
