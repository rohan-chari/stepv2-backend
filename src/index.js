require("dotenv").config();

const { createApp } = require("./app");
const { registerEventHandlers } = require("./handlers/eventHandlers");
const { registerNotificationHandlers } = require("./handlers/notificationHandlers");
const { scheduleRaceExpiryCheck } = require("./jobs/raceExpiry");
const { scheduleSeededRaceRenewal } = require("./jobs/seededRaceRenewal");
const { scheduleComputeRanks } = require("./jobs/computeRanks");
const { scheduleComputeRankedWeeks } = require("./jobs/computeRankedWeeks");
const { scheduleGlobalStepEvents } = require("./jobs/globalStepEventScheduler");
const {
  scheduleAutoStartScheduledRaces,
} = require("./jobs/autoStartScheduledRaces");
const { scheduleRecomputePlacements } = require("./jobs/placementRecompute");

function startServer({
  app = createApp(),
  port = Number(process.env.PORT || 3000),
  host = process.env.HOST || "0.0.0.0",
  registerEventHandlers: register = registerEventHandlers,
  registerNotificationHandlers: registerNotifications = registerNotificationHandlers,
  scheduleRaceExpiryCheck: scheduleRaceExpiry = scheduleRaceExpiryCheck,
  scheduleSeededRaceRenewal: scheduleSeededRenewal = scheduleSeededRaceRenewal,
  scheduleComputeRanks: scheduleRanks = scheduleComputeRanks,
  scheduleComputeRankedWeeks: scheduleRankedWeeks = scheduleComputeRankedWeeks,
  scheduleGlobalStepEvents: scheduleGlobalEvents = scheduleGlobalStepEvents,
  scheduleAutoStartScheduledRaces:
    scheduleAutoStartRaces = scheduleAutoStartScheduledRaces,
  scheduleRecomputePlacements: scheduleLivePlacements = scheduleRecomputePlacements,
  logger = console,
} = {}) {
  register();
  registerNotifications();

  return app.listen(port, host, () => {
    logger.log(`Steps Tracker API running on ${host}:${port}`);
    scheduleRaceExpiry();
    scheduleSeededRenewal();
    scheduleRanks();
    scheduleRankedWeeks();
    scheduleGlobalEvents();
    scheduleAutoStartRaces();
    // Live placement broadcast (Phase 0). Runs by default like the other jobs. The
    // env var is an emergency kill switch ONLY (set LIVE_PLACEMENT_DISABLED=true to
    // stop the per-placement push fan-out without a code deploy) — kept because this
    // is the one job that can push to the whole user base on a 5-minute cadence.
    if (process.env.LIVE_PLACEMENT_DISABLED !== "true") {
      scheduleLivePlacements();
    }
  });
}

if (require.main === module) {
  startServer();

  if (process.env.NODE_ENV !== "production") {
    let pulling = false;
    process.on("SIGINT", async () => {
      if (pulling) return;
      pulling = true;
      try {
        const { pullCosmetics } = require("../scripts/cosmetics-pull");
        console.log("\nPulling cosmetics to data/cosmetics.json before exit...");
        await pullCosmetics();
      } catch (err) {
        console.error("cosmetics pull on shutdown failed:", err);
      } finally {
        process.exit(0);
      }
    });
  }
}

module.exports = {
  startServer,
};
