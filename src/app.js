const cors = require("cors");
const express = require("express");

const { createAuthRouter } = require("./routes/auth");
const { createStepsRouter } = require("./routes/steps");
const { createFriendsRouter } = require("./routes/friends");
const { createChallengesRouter } = require("./routes/challenges");
const { createStakesRouter } = require("./routes/stakes");
const { createAdminRouter } = require("./routes/admin");
const { createNotificationsRouter } = require("./routes/notifications");

function createApp(dependencies = {}) {
  const app = express();

  app.use(cors());
  app.use(express.json());

  app.use("/auth", createAuthRouter(dependencies));
  app.use("/steps", createStepsRouter(dependencies));
  app.use("/friends", createFriendsRouter(dependencies));
  app.use("/challenges", createChallengesRouter(dependencies));
  app.use("/stakes", createStakesRouter(dependencies));
  app.use("/admin", createAdminRouter(dependencies));
  app.use("/notifications", createNotificationsRouter(dependencies));

  app.get("/health", (req, res) => {
    res.json({ status: "ok" });
  });

  return app;
}

module.exports = { createApp };
