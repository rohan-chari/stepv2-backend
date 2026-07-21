const { Router } = require("express");
const { buildRequireAuth } = require("../../../middleware/requireAuth");
const {
  getStepMilestonesToday: defaultGetStepMilestonesToday,
} = require("../queries/getStepMilestonesToday");
const {
  claimStepMilestone: defaultClaimStepMilestone,
  StepMilestoneError,
} = require("../commands/claimStepMilestone");

function createStepMilestonesRouter(dependencies = {}) {
  const router = Router();
  const requireAuth =
    dependencies.requireAuth || buildRequireAuth(dependencies);
  const getStepMilestonesToday =
    dependencies.getStepMilestonesToday || defaultGetStepMilestonesToday;
  const claimStepMilestone =
    dependencies.claimStepMilestone || defaultClaimStepMilestone;

  router.use(requireAuth);

  router.get("/today", async (req, res) => {
    try {
      const localDate = req.query.localDate;
      if (!localDate) {
        return res
          .status(400)
          .json({ error: "localDate query param required (YYYY-MM-DD)" });
      }
      const status = await getStepMilestonesToday({
        userId: req.user.id,
        localDate,
      });
      res.json(status);
    } catch (error) {
      if (error.statusCode) {
        return res.status(error.statusCode).json({ error: error.message });
      }
      console.error("Step milestones today error:", error);
      res.status(500).json({ error: "Internal server error" });
    }
  });

  router.post("/:threshold/claim", async (req, res) => {
    try {
      const localDate = req.body?.localDate;
      const threshold = Number.parseInt(req.params.threshold, 10);
      const result = await claimStepMilestone({
        userId: req.user.id,
        localDate,
        threshold,
      });
      res.json(result);
    } catch (error) {
      if (error instanceof StepMilestoneError) {
        return res
          .status(error.statusCode || 400)
          .json({ error: error.message });
      }
      console.error("Step milestone claim error:", error);
      res.status(500).json({ error: "Internal server error" });
    }
  });

  return router;
}

module.exports = { createStepMilestonesRouter };
