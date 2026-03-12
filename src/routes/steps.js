const { Router } = require("express");
const { recordSteps } = require("../commands/recordSteps");
const { getStepsByDate, getStepsHistory } = require("../queries/getSteps");
const { buildRequireAppleAuth } = require("../middleware/requireAppleAuth");

function createStepsRouter(dependencies = {}) {
  const router = Router();
  const requireAppleAuth =
    dependencies.requireAppleAuth || buildRequireAppleAuth(dependencies);
  const saveSteps = dependencies.recordSteps || recordSteps;
  const readStepsByDate = dependencies.getStepsByDate || getStepsByDate;
  const readStepsHistory = dependencies.getStepsHistory || getStepsHistory;

  router.use(requireAppleAuth);

  // POST /steps
  // Body: { steps, date }
  router.post("/", async (req, res) => {
    try {
      const { steps, date } = req.body;

      if (steps == null || !date) {
        return res.status(400).json({ error: "steps and date are required" });
      }

      const record = await saveSteps({
        userId: req.user.id,
        steps,
        date,
      });
      res.json({ record });
    } catch (error) {
      console.error("Steps error:", error);
      res.status(500).json({ error: "Internal server error" });
    }
  });

  // GET /steps?date=YYYY-MM-DD
  router.get("/", async (req, res) => {
    try {
      const { date } = req.query;

      if (date) {
        const record = await readStepsByDate(req.user.id, date);
        return res.json({ record });
      }

      const records = await readStepsHistory(req.user.id);
      res.json({ records });
    } catch (error) {
      console.error("Steps query error:", error);
      res.status(500).json({ error: "Internal server error" });
    }
  });

  return router;
}

module.exports = { createStepsRouter };
