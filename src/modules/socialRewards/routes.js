const { Router } = require("express");
const { buildRequireAuth } = require("../../middleware/requireAuth");
const defaults = require("./service");

function createSocialRewardsRouter(dependencies = {}) {
  const router = Router();
  const requireAuth = dependencies.requireAuth || buildRequireAuth(dependencies);
  const service = { ...defaults, ...(dependencies.socialRewards || {}) };
  router.use(requireAuth);
  router.get("/status", async (req, res) => {
    try { res.json(await service.status({ userId: req.user.id, db: dependencies.prisma })); }
    catch (error) { console.error("Social rewards status error:", error); res.status(500).json({ error: "Internal server error" }); }
  });
  router.post("/:platform/open", async (req, res) => {
    try { res.json(await service.open({ userId: req.user.id, platform: req.params.platform, db: dependencies.prisma })); }
    catch (error) { if (error.statusCode) return res.status(error.statusCode).json({ error: error.message, code: error.code }); console.error("Social reward open error:", error); res.status(500).json({ error: "Internal server error" }); }
  });
  router.post("/:platform/claim", async (req, res) => {
    try { res.json(await service.claim({ userId: req.user.id, platform: req.params.platform, db: dependencies.prisma, awardCoins: dependencies.awardCoins })); }
    catch (error) { if (error.statusCode) return res.status(error.statusCode).json({ error: error.message, code: error.code }); console.error("Social reward claim error:", error); res.status(500).json({ error: "Internal server error" }); }
  });
  return router;
}
module.exports = { createSocialRewardsRouter };
