const { Router } = require("express");
const { buildRequireAuth } = require("../../middleware/requireAuth");
const {
  extractReleaseChannel,
} = require("../../shared/middleware/releaseChannel");
const {
  extractClientFeatures,
} = require("../../shared/middleware/clientFeatures");
const { appSettings: defaultAppSettings } = require("../../shared/config/appSettings");
const {
  isStrictFlagEnabled,
} = require("../../shared/config/isStrictFlagEnabled");
const {
  getShopBootstrap: defaultGetShopBootstrap,
} = require("./queries/getShopBootstrap");

function createShopBootstrapRouter(dependencies = {}) {
  const router = Router();
  const requireAuth = dependencies.requireAuth || buildRequireAuth(dependencies);
  const settings = dependencies.appSettings || defaultAppSettings;
  const getShopBootstrap =
    dependencies.getShopBootstrap || defaultGetShopBootstrap;

  router.use(requireAuth);
  router.use(extractReleaseChannel);
  router.use(extractClientFeatures);
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
  return router;
}

module.exports = { createShopBootstrapRouter };
