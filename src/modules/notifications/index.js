// Public interface of the notifications module (audit Phase 9k): the event
// subscribers (notification + logging handlers), the Notification audit model
// (two races-domain jobs read it), the three push/cleanup jobs, and the
// prefs + device-token registration router. Downstream-only: every producer
// reaches this module via eventBus.emit, never by import, so no cycle
// mitigations are needed — router still last by convention.
Object.assign(module.exports, require("./notification"));
Object.assign(module.exports, require("./services/notificationDelivery"));
Object.assign(module.exports, require("./notificationHandlers"));
Object.assign(module.exports, require("./eventHandlers"));
Object.assign(module.exports, require("./notificationCleanup"));
Object.assign(module.exports, require("./dailyRewardReminder"));
Object.assign(module.exports, require("./stepMilestoneReminder"));
Object.assign(module.exports, require("./dailyMover"));
Object.assign(module.exports, require("./jobs/notificationScheduleRelease"));
Object.assign(module.exports, require("./jobs/notificationCompletenessReconciler"));
Object.assign(module.exports, require("./jobs/deviceTokenCleanup"));
Object.assign(module.exports, require("./routes"));
