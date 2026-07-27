require("dotenv").config();

const { createApp } = require("./app");
const {
  registerEventHandlers,
  registerNotificationHandlers,
} = require("./modules/notifications");
const { scheduleRaceExpiryCheck } = require("./modules/races");
const { scheduleSeededRaceRenewal } = require("./modules/races");
const {
  scheduleTournamentSeedRenewal,
} = require("./modules/tournaments");
const {
  scheduleComputeRanks,
  scheduleComputeRankedWeeks,
} = require("./modules/ranked");
const { scheduleGlobalStepEvents } = require("./modules/steps");
const { scheduleStepSampleRetention } = require("./modules/steps");
const {
  scheduleAutoStartScheduledRaces,
} = require("./modules/races");
const { scheduleRecomputePlacements } = require("./modules/races");
const { scheduleNotificationCleanup } = require("./modules/notifications");
const {
  scheduleActivationEventCleanup,
} = require("./modules/analytics");
const { scheduleDailyMover } = require("./modules/notifications");
const {
  scheduleDailyRewardReminder,
} = require("./modules/notifications");
const {
  scheduleRaceResolutionWorker,
} = require("./modules/races");
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
  scheduleStepSampleRetention: scheduleStepRetention = scheduleStepSampleRetention,
  scheduleAutoStartScheduledRaces:
    scheduleAutoStartRaces = scheduleAutoStartScheduledRaces,
  scheduleRecomputePlacements: scheduleLivePlacements = scheduleRecomputePlacements,
  scheduleNotificationCleanup: scheduleNotifCleanup = scheduleNotificationCleanup,
  scheduleActivationEventCleanup:
    scheduleActivationCleanup = scheduleActivationEventCleanup,
  scheduleDailyMover: scheduleDaily = scheduleDailyMover,
  scheduleDailyRewardReminder:
    scheduleDailyReminder = scheduleDailyRewardReminder,
  scheduleRaceResolutionWorker: scheduleRaceResolution = scheduleRaceResolutionWorker,
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
      if (process.env.ACTIVATION_EVENT_CLEANUP_DISABLED !== "true") {
        scheduleActivationCleanup();
      }
      // step_samples retention prune (3am ET, 45d + unsettled-race guard;
      // Five-Minute Step Samples §4.1). Kill switch: STEP_SAMPLE_RETENTION_DISABLED=true.
      //
      // ROLLOUT (SHIPPED DARK): this MUST be set to "true" in the prod .env on
      // the initial deploy. The first prod run has to be manually observed (it
      // logs its delete count) BEFORE the switch is removed — an un-observed
      // first prune of a mis-computed cutoff is unrecoverable. The build function
      // ALSO honors the env var, so even if scheduled it no-ops while the switch
      // is "true". Unset (not "true") => the cron RUNS, so do not forget the .env.
      if (process.env.STEP_SAMPLE_RETENTION_DISABLED !== "true") {
        scheduleStepRetention();
      }
      // Daily biggest-mover digest (4pm ET) — like live placement, this can push to
      // the whole active-racer base, so it gets its own kill switch:
      // DAILY_MOVER_DISABLED=true.
      if (process.env.DAILY_MOVER_DISABLED !== "true") {
        scheduleDaily();
      }
      // Daily-reward reminder (5pm & 9pm local per user timezone). Like the other
      // whole-base push jobs it gets a kill switch: DAILY_REWARD_REMINDERS_DISABLED=true.
      // ROLLOUT (§10): this MUST be set to "true" on the initial prod deploy —
      // enable it only AFTER users' timezones have populated for several days and
      // the app release carrying the daily_reward route has rolled out.
      //
      // WARNING: the env var is the ONLY thing holding this back. Do NOT assume
      // a null-timezone user base makes the job inert — dailyRewardReminder
      // unconditionally adds the DEFAULT_ZONE candidate and queries it with
      // includeNull:true, which matches EVERY user whose timezone is still null.
      // Unset, this pushes to the entire base at 5pm/9pm ET on day one.
      if (process.env.DAILY_REWARD_REMINDERS_DISABLED !== "true") {
        scheduleDailyReminder();
      }
      // Durable async race-resolution worker (Home/Races Refresh Performance).
      // Registered after the cron start delay like the other jobs. Two kill
      // switches: ASYNC_RACE_RESOLUTION_DISABLED stops new v2 intake at the
      // route (normal rollback — clients get a definite legacy fallback);
      // ASYNC_RACE_RESOLUTION_WORKER_DISABLED stops this worker draining the
      // queue (emergency DB-load control while queued rows are preserved).
      // Uses its own console (like scheduleTournamentSeedRenewal) rather than the
      // injected startup logger.
      scheduleRaceResolution();
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
