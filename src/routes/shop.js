const { Router } = require("express");
const { buildRequireAuth } = require("../middleware/requireAuth");
const { extractReleaseChannel } = require("../utils/releaseChannel");
const { extractClientFeatures } = require("../utils/clientFeatures");
const {
  getShopCatalog: defaultGetShopCatalog,
} = require("../queries/getShopCatalog");
const {
  purchaseShopItem: defaultPurchaseShopItem,
} = require("../commands/purchaseShopItem");
const {
  equipAccessory: defaultEquipAccessory,
} = require("../commands/equipAccessory");
const {
  getPowerupShopCatalog: defaultGetPowerupShopCatalog,
} = require("../queries/getPowerupShopCatalog");
const {
  purchasePowerupItem: defaultPurchasePowerupItem,
} = require("../commands/purchasePowerupItem");

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
