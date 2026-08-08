const { Router } = require("express");
const { prisma: defaultPrisma } = require("../../db");
const { buildRequireAuth } = require("../../middleware/requireAuth");
const {
  createSuggestion: defaultCreateSuggestion,
} = require("./commands/createSuggestion");

function createFeedbackRouter(dependencies = {}) {
  const router = Router();
  const prisma = dependencies.prisma || defaultPrisma;
  const requireAuth = dependencies.requireAuth || buildRequireAuth(dependencies);
  const createSuggestion =
    dependencies.createSuggestion || defaultCreateSuggestion;

  router.use(requireAuth);

  // POST /feedback/suggestions -> 201 { ok: true }
  // 400 invalid/missing/over-long text, 429 past 5 per user per UTC day.
  router.post("/suggestions", async (req, res) => {
    try {
      const body = req.body || {};
      const result = await createSuggestion({
        userId: req.user.id,
        text: body.text,
        category: body.category,
        // Provenance only — read from headers, never required, never a reason
        // to reject. See sanitizeProvenance.
        appVersion: req.headers["x-app-version"],
        platform: req.headers["x-platform"],
        prisma,
      });
      return res.status(201).json(result);
    } catch (error) {
      if (error.statusCode === 400 || error.statusCode === 429) {
        return res.status(error.statusCode).json({ error: error.message });
      }
      console.error("Suggestion submit error:", error);
      return res.status(500).json({ error: "Internal server error" });
    }
  });

  return router;
}

module.exports = { createFeedbackRouter };
