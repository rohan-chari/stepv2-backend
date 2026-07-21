// Public interface of the analytics module (audit Phase 9e): activation-event
// ingestion (route) + retention cleanup (job). getAdminStats stays with the
// admin surface (its only consumer) and is not part of this module.
const { createAnalyticsRouter } = require("./routes");
const {
  buildCleanupActivationEvents,
  scheduleActivationEventCleanup,
  JOB_NAME,
} = require("./activationEventCleanup");

module.exports = {
  createAnalyticsRouter,
  buildCleanupActivationEvents,
  scheduleActivationEventCleanup,
  JOB_NAME,
};
