const { Router } = require("express");
const { buildRequireAuth } = require("../middleware/requireAuth");
const {
  getDailyRewardStatus: defaultGetDailyRewardStatus,
} = require("../queries/getDailyRewardStatus");
const {
  claimDailyReward: defaultClaimDailyReward,
  DailyRewardError,
} = require("../commands/claimDailyReward");
const {
  claimDailyRewardBox: defaultClaimDailyRewardBox,
} = require("../commands/claimDailyRewardBox");

function createDailyRewardRouter(dependencies = {}) {
  const router = Router();
  const requireAuth =
    dependencies.requireAuth || buildRequireAuth(dependencies);
  const getDailyRewardStatus =
    dependencies.getDailyRewardStatus || defaultGetDailyRewardStatus;
  const claimDailyReward =
    dependencies.claimDailyReward || defaultClaimDailyReward;
  const claimDailyRewardBox =
    dependencies.claimDailyRewardBox || defaultClaimDailyRewardBox;

  router.use(requireAuth);

  router.get("/status", async (req, res) => {
    try {
      const localDate = req.query.localDate;
      if (!localDate) {
        return res
          .status(400)
          .json({ error: "localDate query param required (YYYY-MM-DD)" });
      }
      const status = await getDailyRewardStatus({
        userId: req.user.id,
        localDate,
      });
      res.json(status);
    } catch (error) {
      if (error.statusCode) {
        return res.status(error.statusCode).json({ error: error.message });
      }
      console.error("Daily reward status error:", error);
      res.status(500).json({ error: "Internal server error" });
    }
  });

  router.post("/claim", async (req, res) => {
    try {
      const localDate = req.body?.localDate;
      const result = await claimDailyReward({
        userId: req.user.id,
        localDate,
      });
      res.json(result);
    } catch (error) {
      if (error instanceof DailyRewardError) {
        return res
          .status(error.statusCode || 400)
          .json({ error: error.message });
      }
      console.error("Daily reward claim error:", error);
      res.status(500).json({ error: "Internal server error" });
    }
  });

  // Daily reward v2 (mystery-box roll). New endpoint so old app builds keep
  // hitting /claim with the legacy ladder behavior untouched.
  router.post("/claim-box", async (req, res) => {
    try {
      const localDate = req.body?.localDate;
      const result = await claimDailyRewardBox({
        userId: req.user.id,
        localDate,
      });
      res.json(result);
    } catch (error) {
      if (error instanceof DailyRewardError) {
        return res
          .status(error.statusCode || 400)
          .json({ error: error.message });
      }
      console.error("Daily reward box claim error:", error);
      res.status(500).json({ error: "Internal server error" });
    }
  });

  return router;
}

module.exports = { createDailyRewardRouter };
