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
      // Opt-in flag set only by new app builds. Without it, response is the
      // legacy single-state shape so older clients are unaffected.
      const homeActiveRaces =
        req.query.homeActiveRaces === "1" || req.query.homeActiveRaces === "true";
      const result = await getHomeRaceCard({
        userId: req.user.id,
        homeActiveRaces,
        // Match getRaceProgress: window race steps in the caller's timezone
        // (set globally by the extractTimezone middleware) so the home card and
        // the race-detail screen compute identical race-relative totals.
        timeZone: req.timeZone,
      });
      res.json(result);
    } catch (error) {
      console.error("Home race-card error:", error);
      res.status(500).json({ error: "Internal server error" });
    }
  });

  return router;
}

module.exports = { createHomeRouter };
