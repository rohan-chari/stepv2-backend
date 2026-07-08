const { Router } = require("express");
const { buildRequireAuth } = require("../middleware/requireAuth");
const {
  claimAdCoinReward: defaultClaimAdCoinReward,
} = require("../commands/claimAdCoinReward");
const { DailyRewardError } = require("../commands/claimDailyReward");
const defaultAdRewardsConfig = require("../config/adRewards");

function createCoinsRouter(dependencies = {}) {
  const router = Router();
  const requireAuth =
    dependencies.requireAuth || buildRequireAuth(dependencies);
  const claimAdCoinReward =
    dependencies.claimAdCoinReward || defaultClaimAdCoinReward;
  const adRewardsConfig =
    dependencies.adRewardsConfig || defaultAdRewardsConfig;

  router.use(requireAuth);

  // Watch-ad-for-coins (Get Coins hub), paid by a verified rewarded-ad watch
  // (coin_reward AdRewardGrant minted by /ads/ssv). New endpoint: old
  // binaries never call it.
  router.post("/claim-ad-reward", async (req, res) => {
    if (!adRewardsConfig.ADS_COIN_REWARD_ENABLED) {
      return res.status(503).json({ error: "Ad coin reward is disabled" });
    }
    try {
      const localDate = req.body?.localDate;
      const result = await claimAdCoinReward({
        userId: req.user.id,
        localDate,
      });
      res.json(result);
    } catch (error) {
      if (error instanceof DailyRewardError) {
        // `code` (e.g. AD_NOT_VERIFIED) lets the client distinguish "SSV
        // hasn't landed yet, retry" from terminal 409s.
        return res
          .status(error.statusCode || 400)
          .json({ error: error.message, code: error.code });
      }
      console.error("Ad coin reward claim error:", error);
      res.status(500).json({ error: "Internal server error" });
    }
  });

  return router;
}

module.exports = { createCoinsRouter };
