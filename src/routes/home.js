const { Router } = require("express");
const { buildRequireAuth } = require("../middleware/requireAuth");
const {
  getHomeRaceCard: defaultGetHomeRaceCard,
} = require("../queries/getHomeRaceCard");

function createHomeRouter(dependencies = {}) {
  const router = Router();
  const requireAuth =
    dependencies.requireAuth || buildRequireAuth(dependencies);
  const getHomeRaceCard =
    dependencies.getHomeRaceCard || defaultGetHomeRaceCard;

  router.use(requireAuth);

  router.get("/race-card", async (req, res) => {
    try {
      const result = await getHomeRaceCard({ userId: req.user.id });
      res.json(result);
    } catch (error) {
      console.error("Home race-card error:", error);
      res.status(500).json({ error: "Internal server error" });
    }
  });

  return router;
}

module.exports = { createHomeRouter };
