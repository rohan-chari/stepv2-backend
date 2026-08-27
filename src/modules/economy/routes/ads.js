const { Router } = require("express");
const { buildRequireAuth } = require("../../../middleware/requireAuth");
const { asyncHandler } = require("../../../shared/http/asyncHandler");
const {
  parseSsvQuery,
  verifySsvSignature,
  buildKeyFetcher,
} = require("../admobSsv");
const {
  buildGrantAdReward,
  grantAdReward: defaultGrantAdReward,
} = require("../commands/grantAdReward");
const defaultAdRewardsConfig = require("../adRewards");
const {
  safeStructuredEvent,
} = require("../../races/services/racePayoutDoublePolicy");
const {
  parseEligibilityQuery,
  parsePermitBody,
  parseImpressionBody,
  parsePermitId,
} = require("../validation/interstitialAds");
const {
  buildGetInterstitialEligibility,
} = require("../queries/getInterstitialEligibility");
const {
  buildIssueInterstitialPermit,
} = require("../commands/issueInterstitialPermit");
const {
  buildConfirmInterstitialImpression,
} = require("../commands/confirmInterstitialImpression");
const {
  buildCancelInterstitialPermit,
} = require("../commands/cancelInterstitialPermit");

function rawInterstitialTimeZone(req) {
  const raw = req.headers && req.headers["x-timezone"];
  return typeof raw === "string" && raw === req.timeZone ? raw : null;
}

// AdMob server-side verification callback. Unauthenticated — GOOGLE calls it
// (configured on the ad unit in the AdMob console), and its trust comes from
// the ECDSA signature over the query string, not from our auth. This route is
// the ONLY minter of AdRewardGrants; the app never gets to say "I watched an
// ad".
function createAdsRouter(dependencies = {}) {
  const router = Router();
  const requireAuth =
    dependencies.requireAuth || buildRequireAuth(dependencies);
  const now = dependencies.now || (() => new Date());
  const getInterstitialEligibility =
    dependencies.getInterstitialEligibility ||
    buildGetInterstitialEligibility(dependencies);
  const issueInterstitialPermit =
    dependencies.issueInterstitialPermit ||
    buildIssueInterstitialPermit({
      ...dependencies,
      getInterstitialEligibility,
    });
  const confirmInterstitialImpression =
    dependencies.confirmInterstitialImpression ||
    buildConfirmInterstitialImpression(dependencies);
  const cancelInterstitialPermit =
    dependencies.cancelInterstitialPermit ||
    buildCancelInterstitialPermit(dependencies);
  const grantAdReward =
    dependencies.grantAdReward ||
    (dependencies.prisma || dependencies.logger
      ? buildGrantAdReward(dependencies)
      : defaultGrantAdReward);
  const config = dependencies.adRewardsConfig || defaultAdRewardsConfig;
  const logger = dependencies.logger || console;
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
        safeStructuredEvent(logger, {
          event: "race_payout_double_ssv_metric",
          outcome: "missing_params",
        });
        return res.json({ ok: false, reason: "missing_params" });
      }

      if (!config.ADMOB_SSV_SKIP_VERIFY && !(await verifySsv(rawQuery))) {
        safeStructuredEvent(logger, {
          event: "race_payout_double_ssv_metric",
          outcome: "invalid_signature",
        });
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
      safeStructuredEvent(logger, {
        event: "race_payout_double_ssv_metric",
        outcome: "internal_error",
      });
      try { logger.error("AdMob SSV callback error:", error); } catch {}
      res.status(500).json({ error: "Internal server error" });
    }
  });

  // These routes are authenticated individually. Never put requireAuth on the
  // router itself: /ssv above is called by Google and must remain public.
  router.get(
    "/interstitial/eligibility",
    requireAuth,
    asyncHandler(async (req, res) => {
      const receivedAt = now();
      const input = parseEligibilityQuery(req, receivedAt);
      const body = await getInterstitialEligibility({
        userId: req.user.id,
        userCreatedAt: req.user.createdAt,
        ...input,
        timeZone: rawInterstitialTimeZone(req),
        now: receivedAt,
      });
      res.status(200).json(body);
    }),
  );

  router.post(
    "/interstitial/permits",
    requireAuth,
    asyncHandler(async (req, res) => {
      const receivedAt = now();
      const input = parsePermitBody(req.body, receivedAt);
      const result = await issueInterstitialPermit({
        userId: req.user.id,
        userCreatedAt: req.user.createdAt,
        ...input,
        timeZone: rawInterstitialTimeZone(req),
        now: receivedAt,
      });
      res.status(result.status).json(result.body);
    }),
  );

  router.post(
    "/interstitial/impressions",
    requireAuth,
    asyncHandler(async (req, res) => {
      const receivedAt = now();
      const input = parseImpressionBody(req.body, receivedAt);
      const body = await confirmInterstitialImpression({
        userId: req.user.id,
        ...input,
        now: receivedAt,
      });
      res.status(202).json(body);
    }),
  );

  router.post(
    "/interstitial/permits/:permitId/cancel",
    requireAuth,
    asyncHandler(async (req, res) => {
      const permitId = parsePermitId(req.params.permitId);
      const body = await cancelInterstitialPermit({
        userId: req.user.id,
        permitId,
        now: now(),
      });
      res.status(202).json(body);
    }),
  );

  return router;
}

module.exports = { createAdsRouter, rawInterstitialTimeZone };
