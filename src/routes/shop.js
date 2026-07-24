const { Router } = require("express");
const { buildRequireAuth } = require("../middleware/requireAuth");
const { extractReleaseChannel } = require("../shared/middleware/releaseChannel");
const { extractClientFeatures } = require("../shared/middleware/clientFeatures");
const {
  getShopCatalog: defaultGetShopCatalog,
  purchaseShopItem: defaultPurchaseShopItem,
  equipAccessory: defaultEquipAccessory,
} = require("../modules/cosmetics");
const {
  getPowerupShopCatalog: defaultGetPowerupShopCatalog,
} = require("../modules/powerups");
const {
  purchasePowerupItem: defaultPurchasePowerupItem,
} = require("../modules/powerups");
const {
  unlockPowerupWithAds: defaultUnlockPowerupWithAds,
} = require("../modules/powerups");
const {
  POWERUPS5_GATED_TYPES,
} = require("../modules/powerups/constants/powerupGating");

// SKUs of the Wave 5 store-only powerups (POWERUP_<TYPE>). Kept alongside the
// type list so the purchase guard can reject by either sku or powerupType.
const POWERUPS5_SKUS = POWERUPS5_GATED_TYPES.map((t) => `POWERUP_${t}`);

function createShopRouter(dependencies = {}) {
  const router = Router();
  const requireAuth =
    dependencies.requireAuth || buildRequireAuth(dependencies);
  const getShopCatalog = dependencies.getShopCatalog || defaultGetShopCatalog;
  const purchaseShopItem =
    dependencies.purchaseShopItem || defaultPurchaseShopItem;
  const equipAccessory = dependencies.equipAccessory || defaultEquipAccessory;
  const getPowerupShopCatalog =
    dependencies.getPowerupShopCatalog || defaultGetPowerupShopCatalog;
  const purchasePowerupItem =
    dependencies.purchasePowerupItem || defaultPurchasePowerupItem;
  const unlockPowerupWithAds =
    dependencies.unlockPowerupWithAds || defaultUnlockPowerupWithAds;

  router.use(requireAuth);
  router.use(extractReleaseChannel);
  router.use(extractClientFeatures);

  // ── Powerup store (additive; only the new app calls these) ──────────────
  // GET /shop/powerups — active coin-purchasable powerups + balance + owned qty.
  router.get("/powerups", async (req, res) => {
    try {
      const result = await getPowerupShopCatalog(req.user.id, {
        channel: req.releaseChannel,
        supportsJammer: req.clientFeatures.has("jammer"),
        supportsPowerups2: req.clientFeatures.has("powerups2"),
        supportsPowerups3: req.clientFeatures.has("powerups3"),
        supportsPowerups4: req.clientFeatures.has("powerups4"),
        supportsPowerups5: req.clientFeatures.has("powerups5"),
      });
      res.json(result);
    } catch (error) {
      console.error("Get powerup shop catalog error:", error);
      res.status(500).json({ error: "Internal server error" });
    }
  });

  // POST /shop/powerups/purchase — buy a powerup (idempotent via Idempotency-Key).
  router.post("/powerups/purchase", async (req, res) => {
    try {
      if (req.body?.powerupType === "QUICKSAND" && !req.clientFeatures.has("powerups4")) {
        return res.status(404).json({ error: "Powerup not found" });
      }
      // Wave 5 store-only powerups: reject a purchase from a non-powerups5 client
      // by sku OR powerupType, mirroring the Quicksand guard above. Old binaries
      // never learn these skus (the catalog filters them), but a stale/replayed
      // request must not slip a wave-5 item into an unsupported client.
      if (
        (POWERUPS5_GATED_TYPES.includes(req.body?.powerupType) ||
          POWERUPS5_SKUS.includes(req.body?.sku)) &&
        !req.clientFeatures.has("powerups5")
      ) {
        return res.status(404).json({ error: "Powerup not found" });
      }
      const result = await purchasePowerupItem({
        userId: req.user.id,
        sku: req.body.sku,
        powerupType: req.body.powerupType,
        idempotencyKey: req.get("Idempotency-Key") || req.body.idempotencyKey,
        channel: req.releaseChannel,
      });
      res.json(result);
    } catch (error) {
      if (error.name === "PowerupPurchaseError") {
        return res
          .status(error.statusCode || 400)
          .json({ error: error.message });
      }
      console.error("Powerup purchase error:", error);
      res.status(500).json({ error: "Internal server error" });
    }
  });

  // POST /shop/powerups/unlock-with-ads — item 10. Body { sku, idempotencyKey }
  // (+ Idempotency-Key header). Server recomputes shortfall + ad count and
  // requires SSV-verified watches; on success zeroes coins and grants the
  // powerup. Additive; only the new app calls it. Ships dark-safe.
  router.post("/powerups/unlock-with-ads", async (req, res) => {
    try {
      const result = await unlockPowerupWithAds({
        userId: req.user.id,
        sku: req.body.sku,
        idempotencyKey: req.get("Idempotency-Key") || req.body.idempotencyKey,
        channel: req.releaseChannel,
      });
      res.json(result);
    } catch (error) {
      if (error.name === "UnlockWithAdsError") {
        return res
          .status(error.statusCode || 400)
          .json({ error: error.message, ...(error.code ? { code: error.code } : {}) });
      }
      console.error("Powerup unlock-with-ads error:", error);
      res.status(500).json({ error: "Internal server error" });
    }
  });

  router.get("/catalog", async (req, res) => {
    try {
      const result = await getShopCatalog(req.user.id, {
        channel: req.releaseChannel,
        supportsCharacters: req.clientFeatures.has("characters"),
      });
      res.json(result);
    } catch (error) {
      console.error("Get shop catalog error:", error);
      res.status(500).json({ error: "Internal server error" });
    }
  });

  router.post("/items/:itemId/purchase", async (req, res) => {
    try {
      const result = await purchaseShopItem({
        userId: req.user.id,
        itemId: req.params.itemId,
        idempotencyKey: req.get("Idempotency-Key"),
        channel: req.releaseChannel,
        supportsCharacters: req.clientFeatures.has("characters"),
      });
      res.json(result);
    } catch (error) {
      if (error.name === "ShopPurchaseError") {
        return res
          .status(error.statusCode || 400)
          .json({ error: error.message });
      }
      console.error("Shop purchase error:", error);
      res.status(500).json({ error: "Internal server error" });
    }
  });

  router.put("/equipment/:slot", async (req, res) => {
    try {
      const result = await equipAccessory({
        userId: req.user.id,
        slot: req.params.slot,
        itemId: req.body.itemId,
        channel: req.releaseChannel,
        supportsCharacters: req.clientFeatures.has("characters"),
      });
      res.json(result);
    } catch (error) {
      if (error.name === "AccessoryEquipError") {
        return res
          .status(error.statusCode || 400)
          .json({ error: error.message });
      }
      console.error("Equip accessory error:", error);
      res.status(500).json({ error: "Internal server error" });
    }
  });

  return router;
}

module.exports = { createShopRouter };
