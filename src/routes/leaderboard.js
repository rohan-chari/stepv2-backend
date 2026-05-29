const { Router } = require("express");
const { buildRequireAuth } = require("../middleware/requireAuth");
const { getLeaderboard: defaultGetLeaderboard } = require("../queries/getLeaderboard");

const VALID_PERIODS = ["today", "week", "month", "allTime"];
const VALID_TYPES = ["steps", "races"];

function createLeaderboardRouter(dependencies = {}) {
  const router = Router();
  const requireAuth =
    dependencies.requireAuth || buildRequireAuth(dependencies);
  const getLeaderboard = dependencies.getLeaderboard || defaultGetLeaderboard;

  router.use(requireAuth);

  // Compat shim: the "Climbing the boards" home section (and its
  // getLeaderboardHighlights query) were removed. Shipped app versions still
  // GET /leaderboard/highlights on home load, so this responds with an empty
  // card list rather than 404ing them. New clients don't call it. Safe to drop
  // once those old app versions have aged out.
  router.get("/highlights", (req, res) => {
    res.json({ cards: [] });
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
