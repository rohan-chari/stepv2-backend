const { Router } = require("express");
const { buildRequireAuth } = require("../middleware/requireAuth");
const {
  getPowerupInventory: defaultGetPowerupInventory,
} = require("../queries/getPowerupInventory");
const {
  getPowerupCopyCatalog: defaultGetPowerupCopyCatalog,
} = require("../queries/getPowerupCopyCatalog");

// Global powerup inventory routes (additive; only the new app calls these).
function createPowerupsRouter(dependencies = {}) {
  const router = Router();
  const requireAuth =
    dependencies.requireAuth || buildRequireAuth(dependencies);
  const getPowerupInventory =
    dependencies.getPowerupInventory || defaultGetPowerupInventory;

  const getPowerupCopyCatalog =
    dependencies.getPowerupCopyCatalog || defaultGetPowerupCopyCatalog;

  // GET /powerups/catalog — the single source of truth for powerup copy (§9.5).
  //
  // Declared BEFORE requireAuth on purpose: copy is global, not user-specific,
  // and is neither an authorization nor a capability concern. Registering it here
  // makes it work whether or not a token is attached, which is what "fetch
  // non-blockingly on launch" needs. Old clients never call it; a new client
  // against an older backend gets a 404 and falls back to its persisted or
  // bundled copy, retrying on the next launch/foreground.
  router.get("/catalog", async (_req, res) => {
    try {
      const result = await getPowerupCopyCatalog();
      res.json(result);
    } catch (error) {
      console.error("Get powerup copy catalog error:", error);
      res.status(500).json({ error: "Internal server error" });
    }
  });

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
