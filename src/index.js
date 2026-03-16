require("dotenv").config();

const { createApp } = require("./app");
const { registerEventHandlers } = require("./handlers/eventHandlers");
const { scheduleCronJobs } = require("./jobs/weeklyChallenge");

const app = createApp();
const PORT = process.env.PORT || 3000;

// Register event handlers
registerEventHandlers();

app.listen(PORT, () => {
  console.log(`Steps Tracker API running on port ${PORT}`);

  // Schedule weekly cron jobs (Monday 9AM EST, Sunday 11:59PM EST)
  scheduleCronJobs();
});
