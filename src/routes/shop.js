const { Router } = require("express");
const { buildRequireAuth } = require("../middleware/requireAuth");
const {
  getShopCatalog: defaultGetShopCatalog,
} = require("../queries/getShopCatalog");
const {
  purchaseShopItem: defaultPurchaseShopItem,
} = require("../commands/purchaseShopItem");
const {
  equipAccessory: defaultEquipAccessory,
} = require("../commands/equipAccessory");

function createShopRouter(dependencies = {}) {
  const router = Router();
  const requireAuth =
    dependencies.requireAuth || buildRequireAuth(dependencies);
  const getShopCatalog = dependencies.getShopCatalog || defaultGetShopCatalog;
  const purchaseShopItem =
    dependencies.purchaseShopItem || defaultPurchaseShopItem;
  const equipAccessory = dependencies.equipAccessory || defaultEquipAccessory;

  router.use(requireAuth);

  router.get("/catalog", async (req, res) => {
    try {
      const result = await getShopCatalog(req.user.id);
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
