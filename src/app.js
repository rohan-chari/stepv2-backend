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
const { createShopRouter } = require("./routes/shop");
const { createPowerupsRouter } = require("./routes/powerups");
const { createDailyRewardRouter } = require("./routes/dailyReward");
const { createStepMilestonesRouter } = require("./routes/stepMilestones");
const { createTutorialRouter } = require("./routes/tutorial");
const { createHomeRouter } = require("./routes/home");
const { createAppVersionRouter } = require("./routes/appVersion");
const { extractTimezone } = require("./middleware/extractTimezone");
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
  getSharedRacePreview: defaultGetSharedRacePreview,
} = require("./queries/getSharedRacePreview");

function createApp(dependencies = {}) {
  const app = express();

  app.use(cors());
  app.use(express.json());
  app.use(extractTimezone);

  app.use("/auth", createAuthRouter(dependencies));
  app.use("/steps", createStepsRouter(dependencies));
  app.use("/friends", createFriendsRouter(dependencies));
  app.use("/admin", createAdminRouter(dependencies));
  app.use("/notifications", createNotificationsRouter(dependencies));
  app.use("/leaderboard", createLeaderboardRouter(dependencies));
  app.use("/ranked", createRankedRouter(dependencies));
  app.use("/races", createRacesRouter(dependencies));
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

  app.get("/health", (req, res) => {
    res.json({ status: "ok" });
  });

  // ---- Shareable race links (deep-link verification + web landing page) ----
  const getSharedRacePreview =
    dependencies.getSharedRacePreview || defaultGetSharedRacePreview;

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
    const links = {
      shareUrl: sharing.buildShareUrl(req.params.token),
      appDeepLink: sharing.buildAppDeepLink(req.params.token),
      appStoreUrl: sharing.APP_STORE_URL,
      playStoreUrl: sharing.PLAY_STORE_URL,
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

  return app;
}

module.exports = { createApp };
