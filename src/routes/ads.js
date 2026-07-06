const { Router } = require("express");
const {
  parseSsvQuery,
  verifySsvSignature,
  buildKeyFetcher,
} = require("../utils/admobSsv");
const {
  grantAdReward: defaultGrantAdReward,
} = require("../commands/grantAdReward");
const defaultAdRewardsConfig = require("../config/adRewards");

// AdMob server-side verification callback. Unauthenticated — GOOGLE calls it
// (configured on the ad unit in the AdMob console), and its trust comes from
// the ECDSA signature over the query string, not from our auth. This route is
// the ONLY minter of AdRewardGrants; the app never gets to say "I watched an
// ad".
function createAdsRouter(dependencies = {}) {
  const router = Router();
  const grantAdReward = dependencies.grantAdReward || defaultGrantAdReward;
  const config = dependencies.adRewardsConfig || defaultAdRewardsConfig;
  const fetchKeys = dependencies.fetchSsvKeys || buildKeyFetcher();
  const verifySsv =
    dependencies.verifySsv ||
    (async (rawQuery) =>
      verifySsvSignature({ rawQuery, keys: await fetchKeys() }));

  router.get("/ssv", async (req, res) => {
    try {
      const rawQuery = (req.originalUrl.split("?")[1] || "").toString();
      const params = parseSsvQuery(rawQuery);

      // AdMob's console "verify callback URL" step pings the bare URL (no
      // params, no signature) and requires a 200. Nothing mints without a
      // verified transaction_id/user_id, so acknowledging is harmless.
      if (!params.transaction_id || !params.user_id) {
        return res.json({ ok: false, reason: "missing_params" });
      }

      if (!config.ADMOB_SSV_SKIP_VERIFY && !(await verifySsv(rawQuery))) {
        return res.status(403).json({ error: "Invalid SSV signature" });
      }

      // Duplicates and unknown users still 200: Google retries non-2xx, and
      // a retried callback for an already-minted grant is the normal case.
      await grantAdReward({
        userId: params.user_id,
        transactionId: params.transaction_id,
        adUnit: params.ad_unit || null,
        customData: params.custom_data || null,
        serverDate: new Date().toISOString().slice(0, 10),
      });
      res.json({ ok: true });
    } catch (error) {
      console.error("AdMob SSV callback error:", error);
      res.status(500).json({ error: "Internal server error" });
    }
  });

  return router;
}

module.exports = { createAdsRouter };
