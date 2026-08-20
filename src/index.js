require("dotenv").config();
const { apnsService } = require("./shared/push/apns");
const {
  logPerformanceFlags,
} = require("./shared/config/performanceFlags");
const {
  adValueEnabled,
  destructiveCleanupDisabled,
  raceResolutionPostTaskWorkerDisabled,
  userFanoutDisabled,
} = require("./shared/config/operationalControls");

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
const { scheduleGlobalEventSummaryTick } = require("./modules/steps");
const { scheduleStepSampleRetention } = require("./modules/steps");
const {
  scheduleAutoStartScheduledRaces,
} = require("./modules/races");
const { scheduleRecomputePlacements } = require("./modules/races");
const { scheduleNotificationCleanup } = require("./modules/notifications");
const { scheduleInboxExpiry, scheduleInboxDelivery } = require("./modules/inbox");
const {
  scheduleActivationEventCleanup,
  scheduleAdminMetricsActivityCleanup,
  schedulePushDeliveryCleanup,
  scheduleReferralLinkOpenCleanup,
} = require("./modules/analytics");
const { scheduleDailyMover } = require("./modules/notifications");
const {
  scheduleDailyRewardReminder,
} = require("./modules/notifications");
const {
  scheduleStepMilestoneReminder,
} = require("./modules/notifications");
const {
  scheduleRaceResolutionWorkerV2,
  scheduleRaceResolutionPostTaskRunner,
  scheduleResolvedImpactBoundaryScheduler,
} = require("./modules/races");
const {
  scheduleRacePayoutDoubleReconcile,
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
  scheduleGlobalEventSummaryTick: scheduleGlobalSummary = scheduleGlobalEventSummaryTick,
  scheduleStepSampleRetention: scheduleStepRetention = scheduleStepSampleRetention,
  scheduleAutoStartScheduledRaces:
    scheduleAutoStartRaces = scheduleAutoStartScheduledRaces,
  scheduleRecomputePlacements: scheduleLivePlacements = scheduleRecomputePlacements,
  scheduleNotificationCleanup: scheduleNotifCleanup = scheduleNotificationCleanup,
  scheduleInboxExpiry: scheduleInboxExpiryJob = scheduleInboxExpiry,
  scheduleInboxDelivery: scheduleInboxDeliveryJob = scheduleInboxDelivery,
  scheduleActivationEventCleanup:
    scheduleActivationCleanup = scheduleActivationEventCleanup,
  scheduleAdminMetricsActivityCleanup:
    scheduleMetricsActivityCleanup = scheduleAdminMetricsActivityCleanup,
  schedulePushDeliveryCleanup:
    schedulePushCleanup = schedulePushDeliveryCleanup,
  scheduleReferralLinkOpenCleanup:
    scheduleReferralCleanup = scheduleReferralLinkOpenCleanup,
  scheduleDailyMover: scheduleDaily = scheduleDailyMover,
  scheduleDailyRewardReminder:
    scheduleDailyReminder = scheduleDailyRewardReminder,
  scheduleStepMilestoneReminder:
    scheduleMilestoneReminder = scheduleStepMilestoneReminder,
  // C0: the RACE-keyed worker. The old per-user worker
  // (scheduleRaceResolutionWorker) is deliberately left in the codebase — it is
  // the reverse-handoff rollback target — but this binary never schedules it, so
  // only one bulk writer per race exists at a time.
  scheduleRaceResolutionWorker: scheduleRaceResolution = scheduleRaceResolutionWorkerV2,
  scheduleRaceResolutionPostTasks:
    scheduleResolutionPostTasks = scheduleRaceResolutionPostTaskRunner,
  scheduleResolvedImpactBoundaries:
    scheduleImpactBoundaries = scheduleResolvedImpactBoundaryScheduler,
  scheduleRacePayoutDoubleReconcile:
    schedulePayoutDoubleReconcile = scheduleRacePayoutDoubleReconcile,
  logger = console,
  // Delay before the cron jobs start ticking. Every scheduler fires an
  // immediate first tick, and under pm2 cluster `reload` the OLD process keeps
  // its intervals running for a few seconds after the NEW one starts serving —
  // an immediate tick in the new process would overlap it (the in-process
  // overlap guards don't reach across processes; e.g. seededRaceRenewal could
  // double-create a PENDING race, which has no DB unique to stop it). 15s is
  // far beyond pm2's kill window for the old process. 0 in tests.
  cronStartDelayMs = Number(process.env.CRON_START_DELAY_MS ?? 15_000),
  // Injected only by the dedicated local capacity entrypoint. Normal startup
  // never reads an environment variable that can suppress production crons.
  capacityHttpResolutionOnly = false,
} = {}) {
  register();
  registerNotifications();

  return app.listen(port, host, () => {
    logger.log(`Steps Tracker API running on ${host}:${port}`);
    // Keep dependency-injected startup probes byte-for-byte stable; production
    // uses the default console logger and records the dark-switch snapshot.
    if (logger === console) logPerformanceFlags(logger);
    const startCrons = () => {
      if (capacityHttpResolutionOnly) {
        scheduleRaceResolution();
        scheduleResolutionPostTasks();
        return;
      }
      scheduleRaceExpiry();
      scheduleSeededRenewal();
      scheduleTournamentRenewal();
      scheduleRanks();
      scheduleRankedWeeks();
      scheduleGlobalEvents();
      scheduleGlobalSummary();
      scheduleAutoStartRaces();
      // Live placement broadcast (Phase 0). Runs by default like the other jobs. The
      // env var is an emergency kill switch ONLY (set LIVE_PLACEMENT_DISABLED=true to
      // stop the per-placement push fan-out without a code deploy) — kept because this
      // is the one job that can push to the whole user base on a 5-minute cadence.
      if (!userFanoutDisabled("LIVE_PLACEMENT_DISABLED")) {
        scheduleLivePlacements();
      }
      // Nightly prune of the notifications audit log (1am ET). Kill switch:
      // NOTIFICATION_CLEANUP_DISABLED=true.
      if (!destructiveCleanupDisabled("NOTIFICATION_CLEANUP_DISABLED")) {
        scheduleNotifCleanup();
      }
      if (!destructiveCleanupDisabled("INBOX_EXPIRY_DISABLED")) {
        scheduleInboxExpiryJob();
      }
      if (!userFanoutDisabled("INBOX_DELIVERY_DISABLED")) {
        scheduleInboxDeliveryJob();
      }
      if (!destructiveCleanupDisabled("ACTIVATION_EVENT_CLEANUP_DISABLED")) {
        scheduleActivationCleanup();
      }
      if (!destructiveCleanupDisabled("ADMIN_METRICS_V2_CLEANUP_DISABLED")) {
        scheduleMetricsActivityCleanup();
        schedulePushCleanup();
        scheduleReferralCleanup();
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
      if (!destructiveCleanupDisabled("STEP_SAMPLE_RETENTION_DISABLED")) {
        scheduleStepRetention();
      }
      // Daily biggest-mover digest (4pm ET) — like live placement, this can push to
      // the whole active-racer base, so it gets its own kill switch:
      // DAILY_MOVER_DISABLED=true.
      if (!userFanoutDisabled("DAILY_MOVER_DISABLED")) {
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
      if (!userFanoutDisabled("DAILY_REWARD_REMINDERS_DISABLED")) {
        scheduleDailyReminder();
      }
      // Step-milestone evening reminder (7pm local per user timezone; batch
      // 2026-08-08 item 3). Another whole-base push job, so another kill
      // switch: STEP_MILESTONE_REMINDERS_DISABLED=true.
      // ROLLOUT (SHIPS DARK): this MUST be set to "true" in the prod .env on
      // the initial deploy. Verify on staging first, then remove the switch.
      // The build function ALSO honors the env var at call time, so even if
      // scheduled it no-ops while the switch is "true".
      //
      // WARNING (same trap as the daily-reward job above): do NOT assume a
      // null-timezone user base makes this inert. stepMilestoneReminder
      // unconditionally adds the DEFAULT_ZONE candidate and queries it with
      // includeNull:true, which matches EVERY user whose timezone is still
      // null. Unset, this pushes to the whole eligible base at 7pm ET on day
      // one.
      if (!userFanoutDisabled("STEP_MILESTONE_REMINDERS_DISABLED")) {
        scheduleMilestoneReminder();
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
      scheduleImpactBoundaries();
      // Delivery/publication groups are durable and drain independently of the
      // creation flag. The whole-runner emergency switch is checked here and
      // again on each scheduler tick; disabling it leaves every row untouched.
      if (!raceResolutionPostTaskWorkerDisabled()) {
        scheduleResolutionPostTasks();
      }
      if (adValueEnabled("payoutReconcile")) {
        schedulePayoutDoubleReconcile();
      }
    };
    // Cluster-mode guard: pm2 sets NODE_APP_INSTANCE per worker (0, 1, ...).
    // Only worker 0 schedules crons -- every scheduler above runs unguarded,
    // so more than one worker running them means duplicate race resolutions,
    // duplicate pushes, duplicate payout reconcile, etc.
    // PM2 always provides NODE_APP_INSTANCE. Outside PM2 (local development,
    // one-off single-process runs, and startup tests), an absent value means
    // this is the sole process and therefore the cron owner.
    if (
      process.env.NODE_APP_INSTANCE == null ||
      process.env.NODE_APP_INSTANCE === "0"
    ) {
      if (cronStartDelayMs > 0) {
        logger.log(`[CRON] Job scheduling starts in ${cronStartDelayMs / 1000}s`);
        setTimeout(startCrons, cronStartDelayMs);
      } else {
        startCrons();
      }
    } else {
      logger.log(`[CRON] Skipping cron scheduling on NODE_APP_INSTANCE=${process.env.NODE_APP_INSTANCE}`);
    }
  });
}

function installProductionShutdownHandlers({
  server,
  apnsService: apns = apnsService,
  processObject = process,
  setTimer = setTimeout,
  clearTimer = clearTimeout,
  hardExitMs = 5000,
} = {}) {
  let shuttingDown = false;
  let hardExitTimer = null;
  const shutdown = () => {
    if (shuttingDown) return;
    shuttingDown = true;
    hardExitTimer = setTimer(() => processObject.exit(0), hardExitMs);
    hardExitTimer?.unref?.();
    server.close(async () => {
      try {
        await apns.close();
      } finally {
        if (hardExitTimer) clearTimer(hardExitTimer);
        processObject.exit(0);
      }
    });
  };
  processObject.on("SIGINT", shutdown);
  processObject.on("SIGTERM", shutdown);
  return shutdown;
}

if (require.main === module) {
  const server = startServer();

  // Graceful shutdown for pm2 cluster reloads: stop accepting new connections,
  // let in-flight requests finish, then exit — so a reload drops zero requests.
  // The 5s hard-exit backstop stays under pm2's kill window escalation and
  // covers a hung keep-alive connection.
  if (process.env.NODE_ENV === "production") {
    installProductionShutdownHandlers({ server });
  }

}

module.exports = {
  installProductionShutdownHandlers,
  startServer,
};
