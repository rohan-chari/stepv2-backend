const { Router } = require("express");
const { buildRequireAuth } = require("../../middleware/requireAuth");
const { asyncHandler } = require("../../shared/http/asyncHandler");
const {
  getHomeRaceCard: defaultGetHomeRaceCard,
} = require("./getHomeRaceCard");
const {
  GlobalStepEvent: defaultGlobalStepEvent,
} = require("../steps/models/globalStepEvent");
const {
  getStepMilestonesToday: defaultGetStepMilestonesToday,
} = require("../steps/queries/getStepMilestonesToday");
const {
  getAdExtraSpinStatus: defaultGetAdExtraSpinStatus,
} = require("../economy/queries/getAdExtraSpinStatus");
const defaultAdRewardsConfig = require("../economy/adRewards");
const { appSettings } = require("../../shared/config/appSettings");
const { getNextRaceHome } = require("../races/queries/getNextRaceHome");
const { supportsNextRace } = require("../races/services/nextRacePolicy");
const {
  getSuggestedRaces: defaultGetSuggestedRaces,
} = require("./queries/getSuggestedRaces");

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
  const getAdExtraSpinStatus =
    dependencies.getAdExtraSpinStatus || defaultGetAdExtraSpinStatus;
  const adRewardsConfig = dependencies.adRewardsConfig || defaultAdRewardsConfig;
  const getNextRaceHomeFn = dependencies.getNextRaceHome || getNextRaceHome;
  const getSuggestedRaces =
    dependencies.getSuggestedRaces ||
    (dependencies.getFeaturedRaces ||
    dependencies.getPublicRaces ||
    dependencies.getPublicTournaments ||
    dependencies.logger
      ? require("./queries/getSuggestedRaces").buildGetSuggestedRaces(dependencies)
      : defaultGetSuggestedRaces);

  router.use(requireAuth);

  router.get(
    "/suggested-races",
    asyncHandler(async (req, res) => {
      const result = await getSuggestedRaces({
        userId: req.user.id,
        supportsTeamRaces: req.clientFeatures?.has("team_races") ?? false,
        supportsTournaments:
          req.clientFeatures?.has("tournaments") ?? false,
      });
      res.json(result);
    })
  );

  router.get("/race-card", async (req, res) => {
    try {
      // Opt-in flag set only by new app builds. Without it, response is the
      // legacy single-state shape so older clients are unaffected.
      const homeActiveRaces =
        req.query.homeActiveRaces === "1" || req.query.homeActiveRaces === "true";
      // §6.3 opt-in: only meaningful together with homeActiveRaces. Old clients
      // never send it and keep the live-computation path.
      const homePersistedTotals =
        req.query.homePersistedTotals === "1" ||
        req.query.homePersistedTotals === "true";
      const result = await getHomeRaceCard({
        userId: req.user.id,
        homeActiveRaces,
        homePersistedTotals,
        // Match getRaceProgress: window race steps in the caller's timezone
        // (set globally by the extractTimezone middleware) so the home card and
        // the race-detail screen compute identical race-relative totals.
        timeZone: req.timeZone,
        supportsCharacters: req.clientFeatures?.has("characters") ?? false,
        // Batch 2026-07-26, item 8: TestFlight viewers see test-only characters.
        releaseChannel: req.releaseChannel,
        // TR-702/809: old clients never get a team race on the Home card.
        supportsTeamRaces: req.clientFeatures?.has("team_races") ?? false,
      });

      // Character powers were removed. The key is still sent (always false) so
      // frozen 2.0.x clients — which render the home character-power chip when
      // it is present and true — keep hiding the chip against this backend.
      result.characterPowersEnabled = false;

      // Capability + flag gate is deliberately outside getHomeRaceCard: a
      // frozen client performs none of the new eligibility/discovery queries.
      if (supportsNextRace(req.clientFeatures)) {
        try {
          const [discoveryEnabled, createEnabled] = await Promise.all([
            appSettings.getFlag("openUserRaceDiscoveryEnabled"),
            appSettings.getFlag("quickCreateRaceCtaEnabled"),
          ]);
          result.nextRace =
            discoveryEnabled || createEnabled
              ? await getNextRaceHomeFn({
                  userId: req.user.id,
                  discoveryEnabled,
                  createEnabled,
                })
              : {
                  resolved: true,
                  eligible: false,
                  discoveryEnabled: false,
                  createEnabled: false,
                  openRaces: [],
                };
        } catch (error) {
          console.error("Build Home nextRace error:", error);
          result.nextRace = {
            resolved: false,
            eligible: false,
            discoveryEnabled: false,
            createEnabled: false,
            openRaces: [],
          };
        }
      }

      // Additive: surface the currently-active global step event (if any) as a
      // top-level field of the EXACT same shape getRaceProgress uses, so the new
      // app can render a "2x STEPS — ends in mm:ss" home banner. Old apps ignore
      // the unknown field. Wrapped in try/catch so a DB hiccup never breaks the
      // home card — we just omit the banner.
      try {
        // C1: the cached display variant (falls back to findActiveAt when the
        // flag is off, Redis is down, or an injected test model lacks it).
        // Settlement paths keep calling findActiveInRange/findActiveAt directly.
        const activeEvent =
          typeof globalStepEventModel.findActiveAtCached === "function"
            ? await globalStepEventModel.findActiveAtCached(new Date())
            : await globalStepEventModel.findActiveAt(new Date());
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
        // Additive: daily-reward CLAIM/CLAIMED button state, derived from the
        // user row requireAuth already loaded (zero extra queries). Same
        // fallback story as stepMilestones: when the field is absent (old
        // backend) the app's StreakChip falls back to its standalone fetch.
        result.dailyReward = {
          claimedToday: req.user.lastDailyClaimDate === localDate,
          localDate,
        };
        // Additive: rewarded-ad extra-spin state for the home button, only
        // for ads-capable clients and only once today's box is claimed (the
        // extra spin can't exist before the free one). Failure omits the
        // field; the chip just shows the plain CLAIMED state.
        if (
          result.dailyReward.claimedToday &&
          adRewardsConfig.ADS_EXTRA_SPIN_ENABLED &&
          req.clientFeatures?.has("ads")
        ) {
          try {
            result.dailyReward.adExtraSpin = await getAdExtraSpinStatus({
              userId: req.user.id,
              localDate,
            });
          } catch (adError) {
            console.error("Home race-card adExtraSpin lookup error:", adError);
          }
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
