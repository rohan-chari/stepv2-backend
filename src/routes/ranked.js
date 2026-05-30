const { Router } = require("express");
const { buildRequireAuth } = require("../middleware/requireAuth");
const { getRanked: defaultGetRanked } = require("../queries/getRanked");

function createRankedRouter(dependencies = {}) {
  const router = Router();
  const requireAuth = dependencies.requireAuth || buildRequireAuth(dependencies);
  const getRanked = dependencies.getRanked || defaultGetRanked;

  router.use(requireAuth);

  // GET /ranked — active season, the caller's standing, and the ladder.
  router.get("/", async (req, res) => {
    try {
      const result = await getRanked({
        currentUserId: req.user.id,
        timeZone: req.timeZone,
      });
      res.json(result);
    } catch (error) {
      console.error("Ranked error:", error);
      res.status(500).json({ error: "Internal server error" });
    }
  });

  return router;
}

module.exports = { createRankedRouter };
