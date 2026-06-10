const { Router } = require("express");
const { buildRequireAuth } = require("../middleware/requireAuth");
const { getRanked: defaultGetRanked } = require("../queries/getRanked");
const { getRankedV2: defaultGetRankedV2 } = require("../queries/getRankedV2");

function createRankedRouter(dependencies = {}) {
  const router = Router();
  const requireAuth = dependencies.requireAuth || buildRequireAuth(dependencies);
  const getRanked = dependencies.getRanked || defaultGetRanked;
  const getRankedV2 = dependencies.getRankedV2 || defaultGetRankedV2;

  router.use(requireAuth);

  // GET /ranked/v2 — weekly-cohort ladder (app >= 1.3.0). The legacy GET /
  // below keeps serving shipped binaries unchanged.
  router.get("/v2", async (req, res) => {
    try {
      const result = await getRankedV2({ currentUserId: req.user.id });
      res.json(result);
    } catch (error) {
      console.error("Ranked v2 error:", error);
      res.status(500).json({ error: "Internal server error" });
    }
  });

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
