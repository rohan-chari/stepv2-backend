const { Router } = require("express");
const { buildRequireAuth } = require("../middleware/requireAuth");
const { getLeaderboard: defaultGetLeaderboard } = require("../queries/getLeaderboard");
const {
  getLeaderboardHighlights: defaultGetLeaderboardHighlights,
} = require("../queries/getLeaderboardHighlights");

const VALID_PERIODS = ["today", "week", "month", "allTime"];
const VALID_TYPES = ["steps", "challenges", "races"];

function createLeaderboardRouter(dependencies = {}) {
  const router = Router();
  const requireAuth =
    dependencies.requireAuth || buildRequireAuth(dependencies);
  const getLeaderboard = dependencies.getLeaderboard || defaultGetLeaderboard;
  const getLeaderboardHighlights =
    dependencies.getLeaderboardHighlights || defaultGetLeaderboardHighlights;

  router.use(requireAuth);

  router.get("/highlights", async (req, res) => {
    try {
      const result = await getLeaderboardHighlights(req.user.id, req.timeZone);
      res.json(result);
    } catch (error) {
      console.error("Leaderboard highlights error:", error);
      res.status(500).json({ error: "Internal server error" });
    }
  });

  // GET /leaderboard?period=today|week|month|allTime
  router.get("/", async (req, res) => {
    try {
      const type = req.query.type || "steps";
      const period = req.query.period || "today";

      if (!VALID_TYPES.includes(type)) {
        return res.status(400).json({
          error: `Invalid type. Must be one of: ${VALID_TYPES.join(", ")}`,
        });
      }

      if (type === "steps" && !VALID_PERIODS.includes(period)) {
        return res.status(400).json({
          error: `Invalid period. Must be one of: ${VALID_PERIODS.join(", ")}`,
        });
      }

      const result = await getLeaderboard({
        type,
        period,
        currentUserId: req.user.id,
        timeZone: req.timeZone,
      });
      res.json(result);
    } catch (error) {
      console.error("Leaderboard error:", error);
      res.status(500).json({ error: "Internal server error" });
    }
  });

  return router;
}

module.exports = { createLeaderboardRouter };
