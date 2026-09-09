const { Router } = require("express");
const { buildRequireAuth } = require("../../middleware/requireAuth");
const {
  extractReleaseChannel,
} = require("../../shared/middleware/releaseChannel");
const {
  extractClientFeatures,
} = require("../../shared/middleware/clientFeatures");
const {
  appSettings: defaultAppSettings,
} = require("../../shared/config/appSettings");
const {
  isStrictFlagEnabled,
} = require("../../shared/config/isStrictFlagEnabled");
const {
  getShopBootstrap: defaultGetShopBootstrap,
} = require("./queries/getShopBootstrap");
const {
  completeShopTutorial: defaultCompleteShopTutorial,
} = require("./commands/completeShopTutorial");
const { asyncHandler } = require("../../shared/http/asyncHandler");

function createShopBootstrapRouter(dependencies = {}) {
  const router = Router();
  const requireAuth =
    dependencies.requireAuth || buildRequireAuth(dependencies);
  const settings = dependencies.appSettings || defaultAppSettings;
  const getShopBootstrap =
    dependencies.getShopBootstrap || defaultGetShopBootstrap;
  const completeShopTutorial =
    dependencies.completeShopTutorial || defaultCompleteShopTutorial;

  router.use(requireAuth);
  router.use(extractReleaseChannel);
  router.use(extractClientFeatures);
  const reads = require("./queries/getCharacterWardrobes");
  const writes = require("./commands/changeCharacterWardrobe");
  const wardrobeOptions = (req) => ({
    userId: req.user.id,
    channel: req.releaseChannel,
    supportsCharacters: req.clientFeatures?.has("characters") || false,
    supportsRemoteAssets: req.clientFeatures?.has("remote_assets") || false,
  });
  router.get(
    "/characters",
    asyncHandler(async (req, res) =>
      res.json(
        await (
          dependencies.getCharacters || reads.buildGetCharacters(dependencies)
        )({ ...req.query, ...wardrobeOptions(req) }),
      ),
    ),
  );
  router.get(
    "/characters/:characterKey/wardrobe",
    asyncHandler(async (req, res) =>
      res.json(
        await (
          dependencies.getCharacterWardrobe ||
          reads.buildGetCharacterWardrobe(dependencies)
        )({
          ...req.query,
          ...wardrobeOptions(req),
          characterKey: req.params.characterKey,
        }),
      ),
    ),
  );
  router.put(
    "/characters/:characterKey/outfit",
    asyncHandler(async (req, res) =>
      res.json(
        await (dependencies.saveCharacterOutfit || writes.saveCharacterOutfit)({
          ...req.body,
          ...wardrobeOptions(req),
          characterKey: req.params.characterKey,
        }),
      ),
    ),
  );
  router.put(
    "/active-character",
    asyncHandler(async (req, res) =>
      res.json(
        await (dependencies.activateCharacter || writes.activateCharacter)({
          ...req.body,
          ...wardrobeOptions(req),
        }),
      ),
    ),
  );
  router.get("/bootstrap", async (req, res) => {
    if (!(await isStrictFlagEnabled(settings, "apiShopBootstrapV1Enabled"))) {
      return res.status(404).json({ error: "Not found" });
    }
    try {
      const features = req.clientFeatures || new Set();
      const result = await getShopBootstrap({
        userId: req.user.id,
        localDate: req.query.localDate,
        channel: req.releaseChannel,
        supportsCharacters: features.has("characters"),
        supportsRemoteAssets: features.has("remote_assets"),
        supportsJammer: features.has("jammer"),
        supportsPowerups2: features.has("powerups2"),
        supportsPowerups3: features.has("powerups3"),
        supportsPowerups4: features.has("powerups4"),
        supportsPowerups5: features.has("powerups5"),
      });
      res.json(result);
    } catch (error) {
      console.error("Shop bootstrap error:", error);
      res.status(500).json({ error: "Internal server error" });
    }
  });
  router.post(
    "/tutorial/complete",
    asyncHandler(async (req, res) => {
      res.json(await completeShopTutorial({ userId: req.user.id }));
    }),
  );
  return router;
}

module.exports = { createShopBootstrapRouter };
