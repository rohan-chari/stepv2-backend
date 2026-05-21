const path = require("path");
const cors = require("cors");
const express = require("express");

const { createAuthRouter } = require("./routes/auth");
const { createStepsRouter } = require("./routes/steps");
const { createFriendsRouter } = require("./routes/friends");
const { createAdminRouter } = require("./routes/admin");
const { createNotificationsRouter } = require("./routes/notifications");
const { createLeaderboardRouter } = require("./routes/leaderboard");
const { createRacesRouter } = require("./routes/races");
const { createShopRouter } = require("./routes/shop");
const { createDailyRewardRouter } = require("./routes/dailyReward");
const { extractTimezone } = require("./middleware/extractTimezone");

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
  app.use("/races", createRacesRouter(dependencies));
  app.use("/shop", createShopRouter(dependencies));
  app.use("/daily-reward", createDailyRewardRouter(dependencies));

  app.get("/health", (req, res) => {
    res.json({ status: "ok" });
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
