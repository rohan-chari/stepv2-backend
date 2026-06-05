const { Router } = require("express");
const { buildRequireAuth } = require("../middleware/requireAuth");
const {
  getHomeRaceCard: defaultGetHomeRaceCard,
} = require("../queries/getHomeRaceCard");
const {
  GlobalStepEvent: defaultGlobalStepEvent,
} = require("../models/globalStepEvent");

function createHomeRouter(dependencies = {}) {
  const router = Router();
  const requireAuth =
    dependencies.requireAuth || buildRequireAuth(dependencies);
  const getHomeRaceCard =
    dependencies.getHomeRaceCard || defaultGetHomeRaceCard;
  const globalStepEventModel =
    dependencies.GlobalStepEvent || defaultGlobalStepEvent;

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

      // Additive: surface the currently-active global step event (if any) as a
      // top-level field of the EXACT same shape getRaceProgress uses, so the new
      // app can render a "2x STEPS — ends in mm:ss" home banner. Old apps ignore
      // the unknown field. Wrapped in try/catch so a DB hiccup never breaks the
      // home card — we just omit the banner.
      try {
        const activeEvent = await globalStepEventModel.findActiveAt(new Date());
        if (activeEvent) {
          result.globalEvent = {
            active: true,
            multiplier: Number(activeEvent.multiplier),
            endsAt: activeEvent.endsAt,
          };
        }
      } catch (eventError) {
        console.error("Home race-card globalEvent lookup error:", eventError);
      }

      res.json(result);
    } catch (error) {
      console.error("Home race-card error:", error);
      res.status(500).json({ error: "Internal server error" });
    }
  });

  return router;
}

module.exports = { createHomeRouter };
