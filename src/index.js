require("dotenv").config();

const { createApp } = require("./app");
const { registerEventHandlers } = require("./handlers/eventHandlers");
const { registerNotificationHandlers } = require("./handlers/notificationHandlers");
const { scheduleRaceExpiryCheck } = require("./jobs/raceExpiry");
const { scheduleSeededRaceRenewal } = require("./jobs/seededRaceRenewal");
const {
  scheduleTournamentSeedRenewal,
} = require("./jobs/tournamentSeedRenewal");
const { scheduleComputeRanks } = require("./jobs/computeRanks");
const { scheduleComputeRankedWeeks } = require("./jobs/computeRankedWeeks");
const { scheduleGlobalStepEvents } = require("./jobs/globalStepEventScheduler");
const {
  scheduleAutoStartScheduledRaces,
} = require("./jobs/autoStartScheduledRaces");
const { scheduleRecomputePlacements } = require("./jobs/placementRecompute");
const { scheduleNotificationCleanup } = require("./jobs/notificationCleanup");
const { scheduleDailyMover } = require("./jobs/dailyMover");

function startServer({
  app = createApp(),
  port = Number(process.env.PORT || 3000),
  host = process.env.HOST || "0.0.0.0",
  registerEventHandlers: register = registerEventHandlers,
  registerNotificationHandlers: registerNotifications = registerNotificationHandlers,
  scheduleRaceExpiryCheck: scheduleRaceExpiry = scheduleRaceExpiryCheck,
  scheduleSeededRaceRenewal: scheduleSeededRenewal = scheduleSeededRaceRenewal,
  scheduleTournamentSeedRenewal:
    scheduleTournamentRenewal = scheduleTournamentSeedRenewal,
  scheduleComputeRanks: scheduleRanks = scheduleComputeRanks,
  scheduleComputeRankedWeeks: scheduleRankedWeeks = scheduleComputeRankedWeeks,
  scheduleGlobalStepEvents: scheduleGlobalEvents = scheduleGlobalStepEvents,
  scheduleAutoStartScheduledRaces:
    scheduleAutoStartRaces = scheduleAutoStartScheduledRaces,
  scheduleRecomputePlacements: scheduleLivePlacements = scheduleRecomputePlacements,
  scheduleNotificationCleanup: scheduleNotifCleanup = scheduleNotificationCleanup,
  scheduleDailyMover: scheduleDaily = scheduleDailyMover,
  logger = console,
  // Delay before the cron jobs start ticking. Every scheduler fires an
  // immediate first tick, and under pm2 cluster `reload` the OLD process keeps
  // its intervals running for a few seconds after the NEW one starts serving —
  // an immediate tick in the new process would overlap it (the in-process
  // overlap guards don't reach across processes; e.g. seededRaceRenewal could
  // double-create a PENDING race, which has no DB unique to stop it). 15s is
  // far beyond pm2's kill window for the old process. 0 in tests.
  cronStartDelayMs = Number(process.env.CRON_START_DELAY_MS ?? 15_000),
} = {}) {
  register();
  registerNotifications();

  return app.listen(port, host, () => {
    logger.log(`Steps Tracker API running on ${host}:${port}`);
    const startCrons = () => {
      scheduleRaceExpiry();
      scheduleSeededRenewal();
      scheduleTournamentRenewal();
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
      // Nightly prune of the notifications audit log (1am ET). Kill switch:
      // NOTIFICATION_CLEANUP_DISABLED=true.
      if (process.env.NOTIFICATION_CLEANUP_DISABLED !== "true") {
        scheduleNotifCleanup();
      }
      // Daily biggest-mover digest (4pm ET) — like live placement, this can push to
      // the whole active-racer base, so it gets its own kill switch:
      // DAILY_MOVER_DISABLED=true.
      if (process.env.DAILY_MOVER_DISABLED !== "true") {
        scheduleDaily();
      }
    };
    if (cronStartDelayMs > 0) {
      logger.log(`[CRON] Job scheduling starts in ${cronStartDelayMs / 1000}s`);
      setTimeout(startCrons, cronStartDelayMs);
    } else {
      startCrons();
    }
  });
}

if (require.main === module) {
  const server = startServer();

  // Graceful shutdown for pm2 cluster reloads: stop accepting new connections,
  // let in-flight requests finish, then exit — so a reload drops zero requests.
  // The 5s hard-exit backstop stays under pm2's kill window escalation and
  // covers a hung keep-alive connection.
  if (process.env.NODE_ENV === "production") {
    let shuttingDown = false;
    process.on("SIGINT", () => {
      if (shuttingDown) return;
      shuttingDown = true;
      server.close(() => process.exit(0));
      setTimeout(() => process.exit(0), 5000).unref();
    });
  }

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
