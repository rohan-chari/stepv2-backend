const assert = require("node:assert/strict");
const test = require("node:test");
const { startServer } = require("../../src/index");

function fakeApp() {
  return {
    listen(...args) {
      args[2]();
      return { close() {} };
    },
  };
}

function baseDeps(overrides = {}) {
  const noop = () => {};
  return {
    app: fakeApp(),
    port: 3000,
    cronStartDelayMs: 0,
    processRole: "all",
    registerEventHandlers: noop,
    registerNotificationHandlers: noop,
    registerRaceListCacheInvalidation: noop,
    scheduleBillingReconciliation: noop,
    scheduleRaceExpiryCheck: noop,
    scheduleSeededRaceRenewal: noop,
    scheduleTournamentSeedRenewal: noop,
    scheduleComputeRanks: noop,
    scheduleComputeRankedWeeks: noop,
    scheduleGlobalStepEvents: noop,
    scheduleGenerationHeartbeat: noop,
    scheduleGlobalEventBoundaryDrain: noop,
    scheduleGlobalEventEntitlementEventReconciler: noop,
    scheduleGlobalEventBoundaryStreamScheduler: noop,
    scheduleGlobalEventBoundaryStreamWorker: noop,
    scheduleGlobalEventRedisScheduleHydrator: noop,
    scheduleStepSampleRetention: noop,
    scheduleAutoStartScheduledRaces: noop,
    scheduleRecomputePlacements: noop,
    scheduleNotificationCleanup: noop,
    scheduleInboxExpiry: noop,
    scheduleInboxDelivery: noop,
    scheduleDomainEventProjection: noop,
    scheduleDomainEventRetention: noop,
    scheduleDomainEventReceiptRecovery: noop,
    scheduleNotificationScheduleRelease: noop,
    scheduleNotificationCompletenessReconciler: noop,
    scheduleDeviceTokenCleanup: noop,
    scheduleNotificationDeliveryStreamWorker: noop,
    scheduleActivationEventCleanup: noop,
    scheduleAdminMetricsActivityCleanup: noop,
    schedulePushDeliveryCleanup: noop,
    scheduleReferralLinkOpenCleanup: noop,
    scheduleGiveawayRetention: noop,
    scheduleFeedbackEmailAttemptExpiry: noop,
    scheduleDailyMover: noop,
    scheduleDailyRewardReminder: noop,
    scheduleStepMilestoneReminder: noop,
    scheduleRaceResolutionWorker: noop,
    scheduleStepSyncStreamWorker: noop,
    schedulePowerupRecalcStreamWorker: noop,
    scheduleRaceDirtyStreamWorker: noop,
    scheduleRaceResolutionRecoverySweep: noop,
    scheduleRacePlacementTransitions: noop,
    scheduleRaceResolutionPostTasks: noop,
    scheduleRaceSeriesRenewal: noop,
    scheduleEffectDeadlines: noop,
    scheduleResolvedImpactBoundaries: noop,
    scheduleRaceAdminCommands: noop,
    scheduleRacePayoutDoubleReconcile: noop,
    scheduleFixedTeamPayoutMonitoring: noop,
    scheduleRedisStreamTrimmer: noop,
    databasePoolTelemetry: { start() {} },
    eventSurgeTelemetry: { start() {} },
    logger: { log() {} },
    ...overrides,
  };
}

function trackedQueuePipeline(calls) {
  return {
    scheduleStepSyncStreamWorker() { calls.push("step"); },
    schedulePowerupRecalcStreamWorker() { calls.push("powerup"); },
    scheduleRaceDirtyStreamWorker() { calls.push("dirty"); },
    scheduleRaceResolutionRecoverySweep() { calls.push("recovery"); },
  };
}

test("queue-first race pipeline starts after the cron delay", async () => {
  const calls = [];
  startServer(baseDeps({
    cronStartDelayMs: 20,
    ...trackedQueuePipeline(calls),
  }));

  assert.deepEqual(calls, []);
  await new Promise((resolve) => setTimeout(resolve, 60));
  assert.deepEqual(calls, ["step", "powerup", "dirty", "recovery"]);
});

test("queue-first race pipeline starts immediately when cronStartDelayMs is 0", () => {
  const calls = [];
  startServer(baseDeps(trackedQueuePipeline(calls)));
  assert.deepEqual(calls, ["step", "powerup", "dirty", "recovery"]);
});

test("capacity HTTP+resolution mode schedules only the direct measured resolution workers", () => {
  const calls = [];
  startServer(baseDeps({
    capacityHttpResolutionOnly: true,
    scheduleRaceResolutionWorker() {
      calls.push("scheduleRaceResolutionWorker");
    },
    scheduleRacePlacementTransitions() {
      calls.push("scheduleRacePlacementTransitions");
    },
    scheduleRaceResolutionPostTasks() {
      calls.push("scheduleRaceResolutionPostTasks");
    },
  }));

  assert.deepEqual(calls, [
    "scheduleRaceResolutionWorker",
    "scheduleRacePlacementTransitions",
    "scheduleRaceResolutionPostTasks",
  ]);
});

test("capacity resolution startup reports the exact measured worker readiness handle", () => {
  const worker = { startupReadiness() { return { ready: false }; } };
  let reported = null;
  startServer(baseDeps({
    capacityHttpResolutionOnly: true,
    scheduleRaceResolutionWorker() { return { worker }; },
    reportCapacityResolutionWorker(value) { reported = value; },
  }));
  assert.equal(reported, worker);
});

test("normal startup ignores CAPACITY_HTTP_RESOLUTION_ONLY and keeps queue-first ownership", () => {
  const previous = process.env.CAPACITY_HTTP_RESOLUTION_ONLY;
  process.env.CAPACITY_HTTP_RESOLUTION_ONLY = "true";
  const calls = [];
  try {
    startServer(baseDeps({
      scheduleRaceExpiryCheck() { calls.push("expiry"); },
      scheduleRaceResolutionWorker() { calls.push("legacy-resolution"); },
      ...trackedQueuePipeline(calls),
    }));
  } finally {
    if (previous === undefined) delete process.env.CAPACITY_HTTP_RESOLUTION_ONLY;
    else process.env.CAPACITY_HTTP_RESOLUTION_ONLY = previous;
  }

  assert.ok(calls.includes("expiry"));
  assert.ok(calls.includes("step"));
  assert.ok(calls.includes("powerup"));
  assert.ok(calls.includes("dirty"));
  assert.ok(calls.includes("recovery"));
  assert.equal(calls.includes("legacy-resolution"), false);
});
