const { Router } = require("express");
const { buildRequireAuth } = require("../../middleware/requireAuth");
const { asyncHandler } = require("../../shared/http/asyncHandler");
const { updateRaceSeries: defaultUpdateRaceSeries } = require("./commands/updateRaceSeries");

function createRaceSeriesRouter(dependencies = {}) {
  const router = Router();
  const requireAuth = dependencies.requireAuth || buildRequireAuth(dependencies);
  const commands = dependencies.updateRaceSeries || defaultUpdateRaceSeries;
  router.use(requireAuth);
  router.put("/:seriesId/subscription", asyncHandler(async (req, res) => {
    res.json(await commands.updateSubscription({
      userId: req.user.id,
      seriesId: req.params.seriesId,
      active: req.body?.active,
    }));
  }));
  router.put("/:seriesId", asyncHandler(async (req, res) => {
    res.json(await commands.updateSeries({
      userId: req.user.id,
      seriesId: req.params.seriesId,
      enabled: req.body?.enabled,
    }));
  }));
  return router;
}

module.exports = { createRaceSeriesRouter };
