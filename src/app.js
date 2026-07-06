const path = require("path");
const cors = require("cors");
const express = require("express");

const { createAuthRouter } = require("./routes/auth");
const { createStepsRouter } = require("./routes/steps");
const { createFriendsRouter } = require("./routes/friends");
const { createAdminRouter } = require("./routes/admin");
const { createNotificationsRouter } = require("./routes/notifications");
const { createLeaderboardRouter } = require("./routes/leaderboard");
const { createRankedRouter } = require("./routes/ranked");
const { createRacesRouter } = require("./routes/races");
const { createReferralsRouter } = require("./routes/referrals");
const { createShopRouter } = require("./routes/shop");
const { createPowerupsRouter } = require("./routes/powerups");
const { createDailyRewardRouter } = require("./routes/dailyReward");
const { createStepMilestonesRouter } = require("./routes/stepMilestones");
const { createTutorialRouter } = require("./routes/tutorial");
const { createHomeRouter } = require("./routes/home");
const { createAppVersionRouter } = require("./routes/appVersion");
const { createAdsRouter } = require("./routes/ads");
const { extractTimezone } = require("./middleware/extractTimezone");
const { extractClientFeatures } = require("./utils/clientFeatures");
const sharing = require("./config/sharing");
const {
  buildAppleAppSiteAssociation,
  buildAssetLinks,
} = require("./web/deepLinkFiles");
const {
  renderRaceLandingPage,
  renderRaceNotFoundPage,
} = require("./web/raceLandingPage");
const {
  renderReferralLandingPage,
  renderReferralNotFoundPage,
} = require("./web/referralLandingPage");
const {
  getSharedRacePreview: defaultGetSharedRacePreview,
} = require("./queries/getSharedRacePreview");
const {
  getReferralPreview: defaultGetReferralPreview,
} = require("./queries/getReferralPreview");
const {
  looksLikeReferralCode,
  normalizeReferralCode,
} = require("./lib/referralCode");

function createApp(dependencies = {}) {
  const app = express();

  app.use(cors());
  app.use(express.json());
  app.use(extractTimezone);
  // Capability gating (X-Client-Features) is read app-wide: social surfaces
  // (races, friends, leaderboard, ranked, home) tailor character data to what
  // the client can render, not just the shop.
  app.use(extractClientFeatures);

  app.use("/auth", createAuthRouter(dependencies));
  app.use("/steps", createStepsRouter(dependencies));
  app.use("/friends", createFriendsRouter(dependencies));
  app.use("/admin", createAdminRouter(dependencies));
  app.use("/notifications", createNotificationsRouter(dependencies));
  app.use("/leaderboard", createLeaderboardRouter(dependencies));
  app.use("/ranked", createRankedRouter(dependencies));
  app.use("/races", createRacesRouter(dependencies));
  app.use("/referrals", createReferralsRouter(dependencies));
  app.use("/shop", createShopRouter(dependencies));
  app.use("/powerups", createPowerupsRouter(dependencies));
  app.use("/daily-reward", createDailyRewardRouter(dependencies));
  app.use(
    "/users/me/step-milestones",
    createStepMilestonesRouter(dependencies)
  );
  app.use("/tutorial", createTutorialRouter(dependencies));
  app.use("/home", createHomeRouter(dependencies));
  app.use("/app-version", createAppVersionRouter(dependencies));
  // Unauthenticated by design: Google's AdMob SSV callback, trusted via its
  // ECDSA signature (see routes/ads.js).
  app.use("/ads", createAdsRouter(dependencies));

  app.get("/health", (req, res) => {
    res.json({ status: "ok" });
  });

  // ---- Shareable race links (deep-link verification + web landing page) ----
  const getSharedRacePreview =
    dependencies.getSharedRacePreview || defaultGetSharedRacePreview;
  const getReferralPreview =
    dependencies.getReferralPreview || defaultGetReferralPreview;

  // iOS Universal Link verification. Must be served at this exact path as
  // application/json with NO file extension. Static (no per-request data).
  app.get("/.well-known/apple-app-site-association", (req, res) => {
    res.type("application/json").send(JSON.stringify(buildAppleAppSiteAssociation()));
  });

  // Android App Link verification.
  app.get("/.well-known/assetlinks.json", (req, res) => {
    res.json(buildAssetLinks());
  });

  // Public web landing page for a shared race. Opened only when the app is NOT
  // installed (otherwise the OS routes the universal/app link into the app).
  app.get("/r/:token", async (req, res) => {
    const token = req.params.token;

    // Referral codes share the /r/* namespace with race share tokens; the
    // reserved BARA- prefix disambiguates (race tokens are hyphen-free, so they
    // never match). A prefixed-but-malformed token still renders the referral
    // not-found page rather than being mistaken for a race.
    if (looksLikeReferralCode(token)) {
      const code = normalizeReferralCode(token);
      const refLinks = {
        inviteUrl: sharing.buildShareUrl(code || token),
        appDeepLink: sharing.buildAppDeepLink(code || token),
        appStoreUrl: sharing.APP_STORE_URL,
        // Bake the code into the Play URL so Play Install Referrer attributes
        // Android installs deterministically (no clipboard needed).
        playStoreUrl: code
          ? `${sharing.PLAY_STORE_URL}&referrer=${encodeURIComponent(code)}`
          : sharing.PLAY_STORE_URL,
        ogImageUrl: sharing.OG_IMAGE_URL,
      };
      if (!code) {
        return res
          .status(404)
          .type("html")
          .send(renderReferralNotFoundPage(refLinks));
      }
      try {
        const preview = await getReferralPreview({ code });
        if (!preview) {
          return res
            .status(404)
            .type("html")
            .send(renderReferralNotFoundPage(refLinks));
        }
        return res
          .type("html")
          .send(renderReferralLandingPage(preview, refLinks));
      } catch (error) {
        console.error("Referral landing page error:", error);
        return res
          .status(200)
          .type("html")
          .send(renderReferralNotFoundPage(refLinks));
      }
    }

    const links = {
      shareUrl: sharing.buildShareUrl(token),
      appDeepLink: sharing.buildAppDeepLink(token),
      appStoreUrl: sharing.APP_STORE_URL,
      playStoreUrl: sharing.PLAY_STORE_URL,
      ogImageUrl: sharing.OG_IMAGE_URL,
    };
    try {
      const preview = await getSharedRacePreview({ token: req.params.token });
      if (!preview) {
        return res.status(404).type("html").send(renderRaceNotFoundPage(links));
      }
      res.type("html").send(renderRaceLandingPage(preview, links));
    } catch (error) {
      console.error("Race landing page error:", error);
      // Degrade to the generic install page rather than a 500 — the link should
      // still get a non-installer to the store.
      res.status(200).type("html").send(renderRaceNotFoundPage(links));
    }
  });

  const publicDir = path.join(__dirname, "..", "public");
  app.get("/", (req, res) => res.sendFile(path.join(publicDir, "index.html")));
  app.get("/support", (req, res) => res.sendFile(path.join(publicDir, "support.html")));
  app.get("/support.html", (req, res) => res.sendFile(path.join(publicDir, "support.html")));
  app.get("/privacy", (req, res) => res.sendFile(path.join(publicDir, "privacy.html")));
  app.get("/privacy.html", (req, res) => res.sendFile(path.join(publicDir, "privacy.html")));
  // Bundled share-card image for link previews (point OG_IMAGE_URL at this).
  // 404s harmlessly until a public/share-card.png is added.
  app.get("/share-card.png", (req, res) =>
    res.sendFile(path.join(publicDir, "share-card.png"))
  );
  // AdMob app-ads.txt verification. Crawled by Google at the domain listed as
  // the app's developer website on the store listings; must be text/plain at
  // exactly this path. One file covers every app on this domain.
  app.get("/app-ads.txt", (req, res) =>
    res.type("text/plain").sendFile(path.join(publicDir, "app-ads.txt"))
  );

  return app;
}

module.exports = { createApp };
