const { Router } = require("express");
const { buildRequireAuth } = require("../middleware/requireAuth");
const {
  getHomeRaceCard: defaultGetHomeRaceCard,
} = require("../queries/getHomeRaceCard");
const {
  GlobalStepEvent: defaultGlobalStepEvent,
} = require("../models/globalStepEvent");
const {
  getStepMilestonesToday: defaultGetStepMilestonesToday,
} = require("../queries/getStepMilestonesToday");

function createHomeRouter(dependencies = {}) {
  const router = Router();
  const requireAuth =
    dependencies.requireAuth || buildRequireAuth(dependencies);
  const getHomeRaceCard =
    dependencies.getHomeRaceCard || defaultGetHomeRaceCard;
  const globalStepEventModel =
    dependencies.GlobalStepEvent || defaultGlobalStepEvent;
  const getStepMilestonesToday =
    dependencies.getStepMilestonesToday || defaultGetStepMilestonesToday;

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

      // Additive: when the client sends its local date (new app builds only),
      // embed the step-milestones card data — the EXACT shape of
      // GET /users/me/step-milestones/today — so the claim-rewards card loads
      // in the same response as the rest of the home page instead of racing a
      // 7th request on slow connections. Old builds don't send localDate and
      // keep using the standalone endpoint. A failure just omits the field;
      // the app falls back to the standalone fetch.
      const localDate = req.query.localDate;
      if (localDate) {
        try {
          result.stepMilestones = await getStepMilestonesToday({
            userId: req.user.id,
            localDate,
          });
        } catch (milestoneError) {
          console.error("Home race-card stepMilestones lookup error:", milestoneError);
        }
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
