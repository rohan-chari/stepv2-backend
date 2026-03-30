require("dotenv").config();

const { createApp } = require("./app");
const { registerEventHandlers } = require("./handlers/eventHandlers");
const { registerNotificationHandlers } = require("./handlers/notificationHandlers");
const { scheduleCronJobs } = require("./jobs/weeklyChallenge");
const { scheduleRaceExpiryCheck } = require("./jobs/raceExpiry");

function startServer({
  app = createApp(),
  port = Number(process.env.PORT || 3000),
  host = process.env.HOST || "0.0.0.0",
  registerEventHandlers: register = registerEventHandlers,
  registerNotificationHandlers: registerNotifications = registerNotificationHandlers,
  scheduleCronJobs: schedule = scheduleCronJobs,
  scheduleRaceExpiryCheck: scheduleRaceExpiry = scheduleRaceExpiryCheck,
  logger = console,
} = {}) {
  register();
  registerNotifications();

  return app.listen(port, host, () => {
    logger.log(`Steps Tracker API running on ${host}:${port}`);
    schedule();
    scheduleRaceExpiry();
  });
}

if (require.main === module) {
  startServer();
}

module.exports = {
  startServer,
};
