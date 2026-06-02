const { Router } = require("express");
const { buildRequireAuth } = require("../middleware/requireAuth");
const {
  getPowerupInventory: defaultGetPowerupInventory,
} = require("../queries/getPowerupInventory");

// Global powerup inventory routes (additive; only the new app calls these).
function createPowerupsRouter(dependencies = {}) {
  const router = Router();
  const requireAuth =
    dependencies.requireAuth || buildRequireAuth(dependencies);
  const getPowerupInventory =
    dependencies.getPowerupInventory || defaultGetPowerupInventory;

  router.use(requireAuth);

  // GET /powerups/inventory — the user's owned powerup quantities.
  router.get("/inventory", async (req, res) => {
    try {
      const result = await getPowerupInventory(req.user.id);
      res.json(result);
    } catch (error) {
      console.error("Get powerup inventory error:", error);
      res.status(500).json({ error: "Internal server error" });
    }
  });

  return router;
}

module.exports = { createPowerupsRouter };
