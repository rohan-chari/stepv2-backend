require("dotenv").config();

const { createApp } = require("./app");
const { registerEventHandlers } = require("./handlers/eventHandlers");
const { scheduleCronJobs } = require("./jobs/weeklyChallenge");

function startServer({
  app = createApp(),
  port = Number(process.env.PORT || 3000),
  host = process.env.HOST || "0.0.0.0",
  registerEventHandlers: register = registerEventHandlers,
  scheduleCronJobs: schedule = scheduleCronJobs,
  logger = console,
} = {}) {
  register();

  return app.listen(port, host, () => {
    logger.log(`Steps Tracker API running on ${host}:${port}`);
    schedule();
  });
}

if (require.main === module) {
  startServer();
}

module.exports = {
  startServer,
};
