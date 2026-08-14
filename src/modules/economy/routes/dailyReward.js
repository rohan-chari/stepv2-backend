const { Router } = require("express");
const { buildRequireAuth } = require("../../../middleware/requireAuth");
const { extractReleaseChannel } = require("../../../shared/middleware/releaseChannel");
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
const {
  claimExtraDailyRewardBox: defaultClaimExtraDailyRewardBox,
} = require("../commands/claimExtraDailyRewardBox");
const {
  getAdExtraSpinStatus: defaultGetAdExtraSpinStatus,
} = require("../queries/getAdExtraSpinStatus");
const {
  getAdCoinRewardStatus: defaultGetAdCoinRewardStatus,
} = require("../queries/getAdCoinRewardStatus");
const defaultAdRewardsConfig = require("../adRewards");
const {
  REFERRER_REWARD_COINS,
  REFEREE_REWARD_COINS,
} = require("../../social/referralRewards");
const { appSettings: defaultAppSettings } = require("../../../shared/config/appSettings");
const {
  isStrictFlagEnabled,
} = require("../../../shared/config/isStrictFlagEnabled");

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
  const claimExtraDailyRewardBox =
    dependencies.claimExtraDailyRewardBox || defaultClaimExtraDailyRewardBox;
  const getAdExtraSpinStatus =
    dependencies.getAdExtraSpinStatus || defaultGetAdExtraSpinStatus;
  const getAdCoinRewardStatus =
    dependencies.getAdCoinRewardStatus || defaultGetAdCoinRewardStatus;
  const adRewardsConfig = dependencies.adRewardsConfig || defaultAdRewardsConfig;
  const settings = dependencies.appSettings || defaultAppSettings;

  router.use(requireAuth);
  // Release channel (testOnly gating for powerup prizes). X-Client-Features is
  // already stamped app-wide in app.js.
  router.use(extractReleaseChannel);

  // Daily-box powerup prizes are gated behind the `spinpowerups` client feature:
  // old binaries have no rewardType switch for POWERUP and would render it as
  // "+0 coins", so they must never be offered one (see claimDailyRewardBox).
  // The X-Client-Features header is lowercased when parsed, so the token
  // resolves to "spinpowerups" regardless of how the client cases it.
  function spinPowerupFlags(req) {
    return {
      supportsSpinPowerups: req.clientFeatures?.has("spinpowerups") ?? false,
      supportsJammer: req.clientFeatures?.has("jammer") ?? false,
      supportsPowerups2: req.clientFeatures?.has("powerups2") ?? false,
      supportsPowerups3: req.clientFeatures?.has("powerups3") ?? false,
      supportsPowerups4: req.clientFeatures?.has("powerups4") ?? false,
      supportsPowerups5: req.clientFeatures?.has("powerups5") ?? false,
      channel: req.releaseChannel,
    };
  }

  router.get("/status", async (req, res) => {
    try {
      const localDate = req.query.localDate;
      if (!localDate) {
        return res
          .status(400)
          .json({ error: "localDate query param required (YYYY-MM-DD)" });
      }
      const compact =
        req.query.view === "get-coins-v1" &&
        (await isStrictFlagEnabled(settings, "apiGetCoinsV1Enabled"));
      if (compact) {
        const status = {
          contract: "get-coins-v1",
          claimedToday: req.user.lastDailyClaimDate === localDate,
          referralRewards: {
            referrerCoins: REFERRER_REWARD_COINS,
            refereeCoins: REFEREE_REWARD_COINS,
          },
        };
        if (
          adRewardsConfig.ADS_COIN_REWARD_ENABLED &&
          req.clientFeatures?.has("ads")
        ) {
          status.adCoinReward = await getAdCoinRewardStatus({
            userId: req.user.id,
            localDate,
          });
        }
        return res.json(status);
      }
      const status = await getDailyRewardStatus({
        userId: req.user.id,
        localDate,
        ...spinPowerupFlags(req),
      });
      // Rewarded-ad extra spin: additive, and only for clients that declared
      // the `ads` capability — old binaries never see the field (and the env
      // kill switch hides it from everyone without an app release).
      if (
        adRewardsConfig.ADS_EXTRA_SPIN_ENABLED &&
        req.clientFeatures?.has("ads")
      ) {
        status.adExtraSpin = await getAdExtraSpinStatus({
          userId: req.user.id,
          localDate,
        });
      }
      // Watch-ad-for-coins (Get Coins hub): same additive gating, separate
      // kill switch.
      if (
        adRewardsConfig.ADS_COIN_REWARD_ENABLED &&
        req.clientFeatures?.has("ads")
      ) {
        status.adCoinReward = await getAdCoinRewardStatus({
          userId: req.user.id,
          localDate,
        });
      }
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
        ...spinPowerupFlags(req),
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

  // Extra box spin paid by a verified rewarded-ad watch (AdRewardGrant minted
  // by /ads/ssv). New endpoint: old binaries never call it, and the free
  // /claim + /claim-box guards are untouched.
  router.post("/claim-extra-box", async (req, res) => {
    if (!adRewardsConfig.ADS_EXTRA_SPIN_ENABLED) {
      return res.status(503).json({ error: "Extra spin is disabled" });
    }
    try {
      const localDate = req.body?.localDate;
      const result = await claimExtraDailyRewardBox({
        userId: req.user.id,
        localDate,
        ...spinPowerupFlags(req),
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
      console.error("Daily reward extra box claim error:", error);
      res.status(500).json({ error: "Internal server error" });
    }
  });

  return router;
}

module.exports = { createDailyRewardRouter };
