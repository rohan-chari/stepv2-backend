const { Router } = require("express");
const { buildRequireAuth } = require("../middleware/requireAuth");
const { buildRequireAdmin } = require("../middleware/requireAdmin");
const {
  ensureWeeklyChallengeForDate: defaultEnsureWeeklyChallengeForDate,
  resolveWeeklyChallengeForDate: defaultResolveWeeklyChallengeForDate,
  resetWeeklyChallengeForDate: defaultResetWeeklyChallengeForDate,
  getWeeklyChallengeAdminState: defaultGetWeeklyChallengeAdminState,
} = require("../services/weeklyChallengeState");

function createAdminRouter(dependencies = {}) {
  const router = Router();
  const requireAuth =
    dependencies.requireAuth || buildRequireAuth(dependencies);
  const requireAdmin = buildRequireAdmin(dependencies);
  const ensureWeeklyChallengeForDate =
    dependencies.ensureWeeklyChallengeForDate ||
    defaultEnsureWeeklyChallengeForDate;
  const resolveWeeklyChallengeForDate =
    dependencies.resolveWeeklyChallengeForDate ||
    defaultResolveWeeklyChallengeForDate;
  const resetWeeklyChallengeForDate =
    dependencies.resetWeeklyChallengeForDate ||
    defaultResetWeeklyChallengeForDate;
  const getWeeklyChallengeAdminState =
    dependencies.getWeeklyChallengeAdminState ||
    defaultGetWeeklyChallengeAdminState;

  router.use(requireAuth, requireAdmin);

  router.get("/weekly-challenge", async (req, res) => {
    try {
      const state = await getWeeklyChallengeAdminState();
      res.json(state);
    } catch (error) {
      console.error("Admin weekly challenge state error:", error);
      res.status(500).json({ error: "Internal server error" });
    }
  });

  router.post("/weekly-challenge/ensure-current", async (req, res) => {
    try {
      const result = await ensureWeeklyChallengeForDate();
      res.json(result);
    } catch (error) {
      console.error("Admin ensure weekly challenge error:", error);
      res.status(500).json({ error: "Internal server error" });
    }
  });

  router.post("/weekly-challenge/resolve-current", async (req, res) => {
    try {
      const result = await resolveWeeklyChallengeForDate();
      res.json(result);
    } catch (error) {
      const status = error.statusCode || 500;
      const message =
        status === 500 ? "Internal server error" : error.message;
      console.error("Admin resolve weekly challenge error:", error);
      res.status(status).json({ error: message });
    }
  });

  router.post("/weekly-challenge/reset-current", async (req, res) => {
    try {
      const result = await resetWeeklyChallengeForDate();
      res.json(result);
    } catch (error) {
      const status = error.statusCode || 500;
      const message =
        status === 500 ? "Internal server error" : error.message;
      console.error("Admin reset weekly challenge error:", error);
      res.status(status).json({ error: message });
    }
  });

  return router;
}

module.exports = { createAdminRouter };
