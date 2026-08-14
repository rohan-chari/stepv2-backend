const { Router } = require("express");
const { buildRequireAuth } = require("../../middleware/requireAuth");
const { getRanked: defaultGetRanked } = require("./queries/getRanked");
const { getRankedV2: defaultGetRankedV2 } = require("./queries/getRankedV2");
const {
  markRankedResultsSeen: defaultMarkRankedResultsSeen,
} = require("./commands/markRankedResultsSeen");
const { appSettings: defaultAppSettings } = require("../../shared/config/appSettings");
const {
  isStrictFlagEnabled,
} = require("../../shared/config/isStrictFlagEnabled");

function createRankedRouter(dependencies = {}) {
  const router = Router();
  const requireAuth = dependencies.requireAuth || buildRequireAuth(dependencies);
  const getRanked = dependencies.getRanked || defaultGetRanked;
  const getRankedV2 = dependencies.getRankedV2 || defaultGetRankedV2;
  const markRankedResultsSeen =
    dependencies.markRankedResultsSeen || defaultMarkRankedResultsSeen;
  const settings = dependencies.appSettings || defaultAppSettings;

  router.use(requireAuth);

  // GET /ranked/v2 — weekly-cohort ladder (app >= 1.3.0). The legacy GET /
  // below keeps serving shipped binaries unchanged.
  router.get("/v2", async (req, res) => {
    try {
      const compact =
        req.query.view === "compact-v1" &&
        (await isStrictFlagEnabled(settings, "apiRankedV2CompactV1Enabled"));
      const result = await getRankedV2({
        currentUserId: req.user.id,
        supportsCharacters:
          !compact && (req.clientFeatures?.has("characters") ?? false),
        supportsRemoteAssets:
          !compact && (req.clientFeatures?.has("remote_assets") ?? false),
        compact,
      });
      if (compact) result.contract = "ranked-v2-compact-v1";
      res.json(result);
    } catch (error) {
      console.error("Ranked v2 error:", error);
      res.status(500).json({ error: "Internal server error" });
    }
  });

  // POST /ranked/results/seen — ack the post-settlement summary popup for one
  // settled week. Body: { weekIndex }. Additive + display-only; old app builds
  // never call this. Unknown/non-member weeks are a graceful no-op.
  router.post("/results/seen", async (req, res) => {
    try {
      const { weekIndex } = req.body || {};
      if (!Number.isInteger(weekIndex)) {
        return res.status(400).json({ error: "weekIndex must be an integer" });
      }
      await markRankedResultsSeen({ userId: req.user.id, weekIndex });
      res.json({ success: true });
    } catch (error) {
      if (error.name === "MarkRankedResultsSeenError") {
        return res
          .status(error.statusCode || 400)
          .json({ error: error.message });
      }
      console.error("Mark ranked results seen error:", error);
      res.status(500).json({ error: "Internal server error" });
    }
  });

  // GET /ranked — active season, the caller's standing, and the ladder.
  router.get("/", async (req, res) => {
    try {
      const result = await getRanked({
        currentUserId: req.user.id,
        timeZone: req.timeZone,
        supportsCharacters: req.clientFeatures?.has("characters") ?? false,
        supportsRemoteAssets: req.clientFeatures?.has("remote_assets") ?? false,
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
