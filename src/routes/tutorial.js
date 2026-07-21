const { Router } = require("express");
const { buildRequireAuth } = require("../middleware/requireAuth");
const { awardCoins: defaultAwardCoins } = require("../shared/economy/awardCoins");
const { User: defaultUserModel } = require("../modules/users");

// One-time coin reward for finishing the in-app tutorial.
const TUTORIAL_REWARD_COINS = 100;
const TUTORIAL_REWARD_REASON = "tutorial_complete";

// Additive, back-compatible router. Old app builds never call these endpoints
// (they run the legacy pre-MainShell tutorial with no reward); new builds use
// them for the onboarding tutorial step and the replay buttons.
function createTutorialRouter(dependencies = {}) {
  const router = Router();
  const requireAuth =
    dependencies.requireAuth || buildRequireAuth(dependencies);
  const awardCoins = dependencies.awardCoins || defaultAwardCoins;
  const userModel = dependencies.User || defaultUserModel;

  router.use(requireAuth);

  // POST /tutorial/complete-reward
  // Grants the one-time 100-coin tutorial-completion reward and marks the
  // onboarding tutorial step seen. Idempotent: awardCoins dedups on
  // (reason, refId=userId) via the CoinTransaction ledger, so repeated calls
  // (replaying the tutorial, reinstalling, a second device) never re-grant.
  // Returns { granted, coins } where `coins` is the resulting balance.
  router.post("/complete-reward", async (req, res) => {
    try {
      const userId = req.user.id;
      const { awarded, coins } = await awardCoins({
        userId,
        amount: TUTORIAL_REWARD_COINS,
        reason: TUTORIAL_REWARD_REASON,
        refId: userId,
      });
      // Completing the tutorial also dismisses the onboarding step. Best-effort:
      // the reward (above) is the protected outcome; never fail the grant if the
      // flag write hiccups.
      try {
        await userModel.update(userId, { tutorialOnboardingSeen: true });
      } catch (flagError) {
        console.error("Mark tutorial onboarding seen (reward) error:", flagError);
      }
      res.json({ granted: awarded, coins });
    } catch (error) {
      console.error("Tutorial complete-reward error:", error);
      res.status(500).json({ error: "Internal server error" });
    }
  });

  // POST /tutorial/onboarding-seen
  // Marks the tutorial onboarding step seen without granting (the skip / bail
  // path). Idempotent — safe to call repeatedly. Mirrors
  // POST /races/onboarding/first-race-seen.
  router.post("/onboarding-seen", async (req, res) => {
    try {
      await userModel.update(req.user.id, { tutorialOnboardingSeen: true });
      res.json({ success: true });
    } catch (error) {
      console.error("Mark tutorial onboarding seen error:", error);
      res.status(500).json({ error: "Internal server error" });
    }
  });

  return router;
}

module.exports = { createTutorialRouter };
