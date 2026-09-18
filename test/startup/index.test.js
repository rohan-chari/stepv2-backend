const assert = require("node:assert/strict");
const { spawnSync } = require("node:child_process");
const test = require("node:test");
const { EventEmitter } = require("node:events");

const {
  startServer,
  configureHttpServer,
  installProductionShutdownHandlers,
} = require("../../src/index");

test("HTTP server keeps pooled clients alive without stale-socket resets", () => {
  const server = {};
  configureHttpServer(server);
  assert.equal(server.keepAliveTimeout, 65_000);
  assert.equal(server.headersTimeout, 66_000);
  assert.equal(server.requestTimeout, 30_000);
  assert.equal(server.maxRequestsPerSocket, 100);
});

test("production resolution startup does not load Gmail or OAuth transport code", () => {
  const script = [
    "require('./src/index')",
    "const bad=Object.keys(require.cache).filter((p)=>p.includes('googleWorkspaceFeedbackTransport')||p.includes('google-auth-library'))",
    "process.stdout.write(JSON.stringify(bad))",
    "process.exit(bad.length?1:0)",
  ].join(";");
  const result = spawnSync(process.execPath, ["-e", script], {
    cwd: process.cwd(),
    encoding: "utf8",
    env: {
      ...process.env,
      NODE_ENV: "production",
      STEPS_PROCESS_ROLE: "resolution",
      DATABASE_URL: "postgresql://rohan@localhost:5432/steps-tracker-integration_test",
      DATABASE_POOL_MAX_RESOLUTION: "8",
      DATABASE_POOL_TOTAL_BUDGET: "32",
    },
  });
  assert.equal(result.status, 0, result.stderr || result.stdout);
  assert.match(result.stdout, /\[\]$/);
});

test("startServer listens on 0.0.0.0 by default", () => {
  let listenArgs;
  let registerCalls = 0;
  const scheduleCalls = {};
  const logs = [];
  const server = { close() {} };

  const app = {
    listen(...args) {
      listenArgs = args;
      const onListening = args[2];
      onListening();
      return server;
    },
  };

  const track = (name) => () => {
    scheduleCalls[name] = (scheduleCalls[name] || 0) + 1;
  };

  const startedServer = startServer({
    app,
    port: 3000,
    processRole: "http",
    cronStartDelayMs: 0,
    registerEventHandlers() {
      registerCalls += 1;
    },
    registerNotificationHandlers() {},
    registerRaceListCacheInvalidation() {},
    databasePoolTelemetry: { start() {} },
    eventSurgeTelemetry: { start() {} },
    scheduleRaceExpiryCheck: track("raceExpiry"),
    scheduleSeededRaceRenewal: track("seededRenewal"),
    scheduleTournamentSeedRenewal: () => {},
    scheduleComputeRanks: track("computeRanks"),
    scheduleComputeRankedWeeks: track("computeRankedWeeks"),
    scheduleGlobalStepEvents: track("globalStepEvents"),
    scheduleGenerationHeartbeat: track("generationHeartbeat"),
    scheduleGlobalEventBoundaryDrain: track("globalEventBoundaryDrain"),
    scheduleGlobalEventEntitlementEventReconciler: track("globalEventEntitlementEventReconciler"),
    scheduleGlobalEventBoundaryStreamScheduler: track("globalEventBoundaryStreamScheduler"),
    scheduleGlobalEventBoundaryStreamWorker: track("globalEventBoundaryStreamWorker"),
    scheduleGlobalEventRedisScheduleHydrator: track("globalEventRedisScheduleHydrator"),
    scheduleGlobalEventSummaryTick: track("globalEventSummary"),
    scheduleAutoStartScheduledRaces: track("autoStartScheduledRaces"),
    scheduleRecomputePlacements: track("recomputePlacements"),
    scheduleNotificationCleanup: track("notificationCleanup"),
    scheduleInboxExpiry: track("inboxExpiry"),
    scheduleInboxDelivery: track("inboxDelivery"),
    scheduleDomainEventProjection: track("domainEventProjection"),
    scheduleDomainEventRetention: track("domainEventRetention"),
    scheduleNotificationScheduleRelease: track("notificationScheduleRelease"),
    scheduleNotificationCompletenessReconciler: track("notificationCompletenessReconciler"),
    scheduleDeviceTokenCleanup: track("deviceTokenCleanup"),
    scheduleNotificationDeliveryStreamWorker: track("notificationDeliveryStreamWorker"),
    scheduleActivationEventCleanup: track("activationEventCleanup"),
    scheduleAdminMetricsActivityCleanup: track("adminMetricsActivityCleanup"),
    schedulePushDeliveryCleanup: track("pushDeliveryCleanup"),
    scheduleReferralLinkOpenCleanup: track("referralLinkOpenCleanup"),
    scheduleDailyMover: track("dailyMover"),
    scheduleFixedTeamPayoutMonitoring: track("fixedTeamPayoutMonitoring"),
    scheduleFeedbackEmailAttemptExpiry: track("feedbackEmailAttemptExpiry"),
    scheduleRaceResolutionPostTasks() {},
    scheduleRacePlacementTransitions: track("placementTransitions"),
    databasePoolConfig: {
      role: "all",
      max: 20,
      source: "compatibility-default",
    },
    logger: {
      log(message) {
        logs.push(message);
      },
    },
  });

  assert.equal(startedServer, server);
  assert.deepEqual(listenArgs.slice(0, 2), [3000, "0.0.0.0"]);
  assert.equal(registerCalls, 1);
  assert.deepEqual(scheduleCalls, { generationHeartbeat: 1 });
  assert.deepEqual(logs, [
    "Steps Tracker API running on 0.0.0.0:3000",
    JSON.stringify({
      event: "database_pool_configuration_v1",
      role: "all",
      instance: "0",
      max: 20,
      configSource: "compatibility-default",
    }),
  ]);
});

test("cronStartDelayMs defers job scheduling past the reload overlap window", async () => {
  const scheduleCalls = {};
  const logs = [];
  const app = {
    listen(...args) {
      args[2]();
      return { close() {} };
    },
  };
  const track = (name) => () => {
    scheduleCalls[name] = (scheduleCalls[name] || 0) + 1;
  };

  startServer({
    app,
    port: 3000,
    cronStartDelayMs: 25,
    processRole: "cron",
    registerEventHandlers() {},
    registerNotificationHandlers() {},
    registerRaceListCacheInvalidation() {},
    databasePoolTelemetry: { start() {} },
    eventSurgeTelemetry: { start() {} },
    scheduleBillingReconciliation: () => {},
    scheduleOperationalAlertSpoolImporter: () => {},
    scheduleOperationalEmailAlertDispatcher: () => {},
    scheduleDomainEventReceiptRecovery: () => {},
    scheduleGiveawayRetention: () => {},
    scheduleDailyRewardReminder: () => {},
    scheduleStepMilestoneReminder: () => {},
    scheduleStepSampleRetention: () => {},
    scheduleRacePayoutDoubleReconcile: () => {},
    scheduleRaceExpiryCheck: track("raceExpiry"),
    scheduleSeededRaceRenewal: track("seededRenewal"),
    scheduleComputeRanks: track("computeRanks"),
    scheduleComputeRankedWeeks: track("computeRankedWeeks"),
    scheduleGlobalStepEvents: track("globalStepEvents"),
    scheduleGenerationHeartbeat: track("generationHeartbeat"),
    scheduleGlobalEventBoundaryDrain: track("globalEventBoundaryDrain"),
    scheduleGlobalEventEntitlementEventReconciler: track("globalEventEntitlementEventReconciler"),
    scheduleGlobalEventBoundaryStreamScheduler: track("globalEventBoundaryStreamScheduler"),
    scheduleGlobalEventBoundaryStreamWorker: track("globalEventBoundaryStreamWorker"),
    scheduleGlobalEventRedisScheduleHydrator: track("globalEventRedisScheduleHydrator"),
    scheduleGlobalEventSummaryTick: track("globalEventSummary"),
    scheduleAutoStartScheduledRaces: track("autoStartScheduledRaces"),
    scheduleRecomputePlacements: track("recomputePlacements"),
    scheduleNotificationCleanup: track("notificationCleanup"),
    scheduleInboxExpiry: track("inboxExpiry"),
    scheduleInboxDelivery: track("inboxDelivery"),
    scheduleDomainEventProjection: track("domainEventProjection"),
    scheduleDomainEventRetention: track("domainEventRetention"),
    scheduleNotificationScheduleRelease: track("notificationScheduleRelease"),
    scheduleNotificationCompletenessReconciler: track("notificationCompletenessReconciler"),
    scheduleDeviceTokenCleanup: track("deviceTokenCleanup"),
    scheduleNotificationDeliveryStreamWorker: track("notificationDeliveryStreamWorker"),
    scheduleActivationEventCleanup: track("activationEventCleanup"),
    scheduleAdminMetricsActivityCleanup: track("adminMetricsActivityCleanup"),
    schedulePushDeliveryCleanup: track("pushDeliveryCleanup"),
    scheduleReferralLinkOpenCleanup: track("referralLinkOpenCleanup"),
    scheduleDailyMover: track("dailyMover"),
    scheduleFixedTeamPayoutMonitoring: track("fixedTeamPayoutMonitoring"),
    scheduleFeedbackEmailAttemptExpiry: track("feedbackEmailAttemptExpiry"),
    scheduleRaceResolutionPostTasks() {},
    scheduleRacePlacementTransitions: track("placementTransitions"),
    logger: {
      log(message) {
        logs.push(message);
      },
    },
  });

  // Immediately after listen: server is up, but no cron has been scheduled yet.
  assert.deepEqual(scheduleCalls, { generationHeartbeat: 1 });
  assert.ok(logs.some((l) => l.includes("Job scheduling starts in")));

  await new Promise((resolve) => setTimeout(resolve, 60));
  assert.equal(scheduleCalls.seededRenewal, 1);
  assert.equal(scheduleCalls.raceExpiry, 1);
  assert.equal(scheduleCalls.dailyMover, 1);
});

test("http and resolution process roles do not start the wrong schedulers", () => {
  const start = (processRole, calls) => startServer({
    app: {
      listen(...args) {
        args[2]();
        return { close() {} };
      },
    },
    processRole,
    cronStartDelayMs: 0,
    scheduleBillingReconciliation: () => calls.push("billing"),
    registerEventHandlers() {},
    registerNotificationHandlers() {},
    registerRaceListCacheInvalidation() {},
    databasePoolTelemetry: { start() {} },
    eventSurgeTelemetry: { start() {} },
    scheduleGenerationHeartbeat: () => calls.push("heartbeat"),
    scheduleRaceResolutionWorker: () => calls.push("resolution"),
    scheduleStepSyncStreamWorker: () => calls.push("stepStream"),
    schedulePowerupRecalcStreamWorker: () => calls.push("powerupStream"),
    scheduleRaceDirtyStreamWorker: () => calls.push("raceDirtyStream"),
    scheduleRaceResolutionRecoverySweep: () => calls.push("raceRecovery"),
    scheduleGlobalEventBoundaryStreamWorker: () => calls.push("eventBoundaryWorker"),
    scheduleHistoricalRaceReconciliationWorker: () => calls.push("historical"),
    scheduleRacePlacementTransitions: () => calls.push("placement"),
    scheduleResolvedImpactBoundaries: () => calls.push("impact"),
    scheduleRaceResolutionPostTasks: () => {},
    scheduleRaceAdminCommands: () => {},
    scheduleEffectDeadlines: () => {},
    scheduleRaceSeriesRenewal: () => {},
    logger: { log() {} },
  });

  const httpCalls = [];
  start("http", httpCalls);
  assert.deepEqual(httpCalls, ["heartbeat"]);

  const resolutionCalls = [];
  start("resolution", resolutionCalls);
  assert.deepEqual(resolutionCalls, [
    "heartbeat", "stepStream", "powerupStream", "raceDirtyStream", "raceRecovery",
    "eventBoundaryWorker", "historical", "placement", "impact",
  ]);

  const cronCalls = [];
  startServer({
    app: {
      listen(...args) {
        args[2]();
        return { close() {} };
      },
    },
    processRole: "cron",
    cronStartDelayMs: 0,
    capacityHomeOpenIsolation: true,
    registerEventHandlers() {},
    registerNotificationHandlers() {},
    registerRaceListCacheInvalidation() {},
    databasePoolTelemetry: { start() {} },
    eventSurgeTelemetry: { start() {} },
    scheduleGenerationHeartbeat: () => cronCalls.push("heartbeat"),
    scheduleBillingReconciliation: () => cronCalls.push("billing"),
    logger: { log() {} },
  });
  assert.deepEqual(cronCalls, ["heartbeat", "billing"]);
});

test("dedicated worker roles own only their core queue workers", () => {
  const run = (processRole) => {
    const calls = [];
    const track = (name) => () => calls.push(name);

    startServer({
      app: {
        listen(...args) {
          args[2]();
          return { close() {} };
        },
      },
      processRole,
      cronStartDelayMs: 0,
      // Keeps today's fallback "all" startup path from starting unrelated jobs.
      // Once the dedicated role exists, its explicit role branch should run first.
      capacityHomeOpenIsolation: true,
      registerEventHandlers() {},
      registerNotificationHandlers() {},
      registerRaceListCacheInvalidation() {},
      scheduleGenerationHeartbeat: track("heartbeat"),
      scheduleStepSyncStreamWorker: track("step"),
      schedulePowerupRecalcStreamWorker: track("powerup"),
      scheduleRaceDirtyStreamWorker: track("race"),
      scheduleRaceResolutionRecoverySweep: track("raceRecovery"),
      scheduleGlobalEventBoundaryStreamWorker: track("event"),
      scheduleGlobalEventRedisScheduleHydrator: track("eventHydrator"),
      scheduleGlobalEventBoundaryStreamScheduler: track("eventScheduler"),
      scheduleNotificationDeliveryStreamWorker: track("notification"),
      logger: { log() {} },
    });

    return calls.filter((name) => name !== "heartbeat");
  };

  assert.deepEqual(run("step"), ["step"]);
  assert.deepEqual(run("race"), ["powerup", "race", "raceRecovery"]);
  assert.deepEqual(run("event"), ["eventHydrator", "eventScheduler", "event"]);
  assert.deepEqual(run("notification"), ["notification"]);
});

test("home-open capacity keeps the cron process idle", () => {
  const run = (capacityHomeOpenIsolation) => {
    const calls = [];
    const track = (name) => () => calls.push(name);
    startServer({
      app: { listen(...args) { args[2](); return { close() {} }; } },
      processRole: "cron", cronStartDelayMs: 0, capacityHomeOpenIsolation,
      registerEventHandlers() {}, registerNotificationHandlers() {},
      registerRaceListCacheInvalidation() {},
      scheduleGenerationHeartbeat: track("heartbeat"),
      scheduleRaceExpiryCheck: track("raceExpiry"),
      scheduleSeededRaceRenewal: track("seededRenewal"),
      scheduleTournamentSeedRenewal: track("tournamentRenewal"),
      scheduleComputeRanks: track("ranks"), scheduleComputeRankedWeeks: track("rankedWeeks"),
      scheduleGlobalStepEvents: track("globalEvents"),
      scheduleGlobalEventBoundaryDrain: track("globalBoundary"),
      scheduleGlobalEventEntitlementEventReconciler: track("globalEntitlementReconciler"),
      scheduleGlobalEventBoundaryStreamScheduler: track("globalBoundaryScheduler"),
      scheduleGlobalEventRedisScheduleHydrator: track("globalScheduleHydrator"),
      scheduleGlobalEventSummaryTick: track("globalSummary"),
      scheduleAutoStartScheduledRaces: track("autoStart"),
      scheduleRecomputePlacements: track("placements"),
      scheduleNotificationCleanup: track("notificationCleanup"),
      scheduleInboxExpiry: track("inboxExpiry"), scheduleInboxDelivery: track("inboxDelivery"),
      scheduleDomainEventProjection: track("domainProjection"),
      scheduleDomainEventRetention: track("domainRetention"),
      scheduleNotificationScheduleRelease: track("notificationRelease"),
      scheduleNotificationCompletenessReconciler: track("notificationCompleteness"),
      scheduleDeviceTokenCleanup: track("deviceTokenCleanup"),
      scheduleNotificationDeliveryStreamWorker: track("notificationStream"),
      scheduleActivationEventCleanup: track("activationCleanup"),
      scheduleAdminMetricsActivityCleanup: track("metricsCleanup"),
      schedulePushDeliveryCleanup: track("pushCleanup"),
      scheduleReferralLinkOpenCleanup: track("referralCleanup"),
      scheduleGiveawayRetention: track("giveawayRetention"),
      scheduleFeedbackEmailAttemptExpiry: track("feedbackExpiry"),
      scheduleOperationalAlertSpoolImporter: track("operationalAlertImport"),
      scheduleOperationalEmailAlertDispatcher: track("operationalAlertDispatch"),
      scheduleDailyMover: track("dailyMover"),
      scheduleDailyRewardReminder: track("dailyReward"),
      scheduleStepMilestoneReminder: track("milestone"),
      scheduleStepSampleRetention: track("sampleRetention"),
      scheduleRacePayoutDoubleReconcile: track("payoutReconcile"),
      scheduleFixedTeamPayoutMonitoring: track("teamPayoutMonitor"),
      logger: { log() {} },
    });
    return calls;
  };
  const ordinary = run(false);
  const isolated = run(true);
  assert.ok(ordinary.includes("raceExpiry"), "default false must preserve ordinary cron behavior");
  assert.ok(ordinary.includes("domainProjection"), "default false must preserve delivery cron behavior");
  assert.deepEqual(isolated, ["heartbeat"],
    "home isolation must retain process telemetry without unrelated database writers");
});

test("capacity event-only cron starts the event and delivery pipeline without unrelated fan-outs", () => {
  const calls = [];
  let deliveryDependencies;
  const track = (name) => () => calls.push(name);
  startServer({
    app: { listen(...args) { args[2](); return { close() {} }; } },
    processRole: "cron",
    cronStartDelayMs: 0,
    capacityGlobalEventOnly: true,
    registerEventHandlers() {},
    registerNotificationHandlers() {},
    registerRaceListCacheInvalidation() {},
    scheduleGenerationHeartbeat: track("heartbeat"),
    scheduleGlobalStepEvents: track("globalEvents"),
    scheduleGlobalEventBoundaryDrain: track("boundary"),
    scheduleGlobalEventEntitlementEventReconciler: track("entitlementReconciler"),
    scheduleGlobalEventBoundaryStreamScheduler: track("boundaryScheduler"),
    scheduleGlobalEventRedisScheduleHydrator: track("scheduleHydrator"),
    scheduleNotificationDeliveryStreamWorker: track("notificationStream"),
    scheduleDomainEventProjection: track("projection"),
    scheduleNotificationScheduleRelease: track("release"),
    scheduleNotificationCompletenessReconciler: track("completeness"),
    scheduleInboxDelivery: (dependencies) => {
      calls.push("delivery");
      deliveryDependencies = dependencies;
    },
    scheduleDeviceTokenCleanup: track("tokenCleanup"),
    scheduleDailyMover: track("dailyMover"),
    scheduleDailyRewardReminder: track("dailyReward"),
    scheduleStepMilestoneReminder: track("milestone"),
    scheduleRaceExpiryCheck: track("raceExpiry"),
    scheduleSeededRaceRenewal: track("seededRenewal"),
    scheduleTournamentSeedRenewal: track("tournamentRenewal"),
    scheduleComputeRanks: track("ranks"),
    scheduleComputeRankedWeeks: track("rankedWeeks"),
    scheduleGlobalEventSummaryTick: track("summary"),
    scheduleStepSampleRetention: track("retention"),
    scheduleAutoStartScheduledRaces: track("autoStart"),
    scheduleRecomputePlacements: track("placements"),
    scheduleNotificationCleanup: track("notificationCleanup"),
    scheduleInboxExpiry: track("inboxExpiry"),
    scheduleDomainEventRetention: track("domainRetention"),
    scheduleActivationEventCleanup: track("activationCleanup"),
    scheduleAdminMetricsActivityCleanup: track("metricsCleanup"),
    schedulePushDeliveryCleanup: track("pushCleanup"),
    scheduleReferralLinkOpenCleanup: track("referralCleanup"),
    scheduleGiveawayRetention: track("giveawayCleanup"),
    scheduleRaceResolutionWorker: track("resolution"),
    scheduleRaceResolutionPostTasks: track("postTasks"),
    scheduleResolvedImpactBoundaries: track("impactBoundaries"),
    scheduleRaceAdminCommands: track("adminCommands"),
    scheduleRacePayoutDoubleReconcile: track("payout"),
    logger: { log() {} },
  });
  assert.deepEqual(calls, [
    "heartbeat", "globalEvents", "scheduleHydrator", "boundaryScheduler",
    "notificationStream", "projection", "release", "completeness", "delivery", "tokenCleanup",
  ]);
  assert.equal(deliveryDependencies.userFanoutDisabled("INBOX_DELIVERY_DISABLED"), false);
});

for (const signal of ["SIGINT", "SIGTERM"]) {
  test(`${signal} production wiring closes HTTP then APNs and exits once`, async () => {
    const processObject = new EventEmitter();
    const calls = [];
    processObject.exit = (code) => { calls.push(["exit", code]); };
    const server = {
      close(callback) {
        calls.push(["server.close"]);
        process.nextTick(callback);
      },
    };
    const apns = {
      async close() { calls.push(["apns.close"]); },
    };
    const stopHandles = [{
      async stop() { calls.push(["jobs.stop"]); },
    }];
    let hardExitCallback;
    let hardExitCleared = false;
    installProductionShutdownHandlers({
      server,
      apnsService: apns,
      processObject,
      stopHandles,
      setTimer(callback, delay) {
        assert.ok(delay === 5000 || delay === 4000);
        if (delay === 5000) hardExitCallback = callback;
        return { delay, unref() {} };
      },
      clearTimer() { hardExitCleared = true; },
    });

    processObject.emit(signal);
    processObject.emit(signal);
    await new Promise((resolve) => setImmediate(resolve));
    assert.deepEqual(calls, [
      ["jobs.stop"],
      ["server.close"],
      ["apns.close"],
      ["exit", 0],
    ]);
    assert.equal(hardExitCleared, true);
    if (!hardExitCleared) hardExitCallback();
  });
}
