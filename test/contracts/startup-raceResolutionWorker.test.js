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
    scheduleHistoricalRaceReconciliation: noop,
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


test("production step role owns only STEP_SYNC queue intake", () => {
  const calls = [];
  startServer(baseDeps({
    processRole: "step",
    scheduleStepSyncStreamWorker() { calls.push("step"); },
    schedulePowerupRecalcStreamWorker() { calls.push("powerup"); },
    scheduleRaceDirtyStreamWorker() { calls.push("dirty"); },
    scheduleGlobalEventBoundaryStreamWorker() { calls.push("event-boundary"); },
    scheduleNotificationDeliveryStreamWorker() { calls.push("notification"); },
  }));
  assert.deepEqual(calls, ["step"]);
});

test("production resolution role owns race/powerup work but not step or event transport", () => {
  const calls = [];
  startServer(baseDeps({
    processRole: "resolution",
    scheduleStepSyncStreamWorker() { calls.push("step"); },
    schedulePowerupRecalcStreamWorker() { calls.push("powerup"); },
    scheduleRaceDirtyStreamWorker() { calls.push("dirty"); },
    scheduleRaceResolutionRecoverySweep() { calls.push("recovery"); },
    scheduleGlobalEventBoundaryStreamWorker() { calls.push("event-boundary"); },
    scheduleHistoricalRaceReconciliation() { calls.push("historical"); },
    scheduleRacePlacementTransitions() { calls.push("placement"); },
    scheduleRaceAdminCommands() { calls.push("admin"); },
    scheduleResolvedImpactBoundaries() { calls.push("impact"); },
    scheduleEffectDeadlines() { calls.push("effects"); },
    scheduleRaceSeriesRenewal() { calls.push("series"); },
    scheduleRaceResolutionPostTasks() { calls.push("post"); },
  }));
  assert.deepEqual(calls, [
    "powerup",
    "dirty",
    "recovery",
    "historical",
    "placement",
    "admin",
    "impact",
    "effects",
    "series",
    "post",
  ]);
});

test("production event role exclusively owns global-event Redis transport", () => {
  const calls = [];
  startServer(baseDeps({
    processRole: "event",
    scheduleGlobalEventRedisScheduleHydrator() { calls.push("hydrate"); },
    scheduleGlobalEventBoundaryStreamScheduler() { calls.push("schedule"); },
    scheduleGlobalEventBoundaryStreamWorker() { calls.push("boundary"); },
    scheduleStepSyncStreamWorker() { calls.push("step"); },
    scheduleNotificationDeliveryStreamWorker() { calls.push("notification"); },
  }));
  assert.deepEqual(calls, ["hydrate", "schedule", "boundary"]);
});

test("production notification role exclusively owns notification projection and delivery", () => {
  const calls = [];
  startServer(baseDeps({
    processRole: "notification",
    scheduleDomainEventProjection() { calls.push("projection"); },
    scheduleNotificationScheduleRelease() { calls.push("release"); },
    scheduleNotificationCompletenessReconciler() { calls.push("reconcile"); },
    scheduleInboxDelivery() { calls.push("inbox"); },
    scheduleNotificationDeliveryStreamWorker() { calls.push("delivery"); },
    scheduleStepSyncStreamWorker() { calls.push("step"); },
    scheduleGlobalEventBoundaryStreamWorker() { calls.push("event"); },
  }));
  assert.deepEqual(calls, [
    "projection",
    "release",
    "reconcile",
    "inbox",
    "delivery",
  ]);
});

test("production cron owns periodic event creation and trimming, not queue consumers", () => {
  const calls = [];
  startServer(baseDeps({
    processRole: "cron",
    scheduleBillingReconciliation() { calls.push("billing"); },
    scheduleRedisStreamTrimmer() { calls.push("trim"); },
    scheduleGlobalStepEvents() { calls.push("global-events"); },
    scheduleGlobalEventRedisScheduleHydrator() { calls.push("hydrate"); },
    scheduleGlobalEventBoundaryStreamScheduler() { calls.push("boundary-scheduler"); },
    scheduleGlobalEventBoundaryStreamWorker() { calls.push("boundary-worker"); },
    scheduleStepSyncStreamWorker() { calls.push("step"); },
    schedulePowerupRecalcStreamWorker() { calls.push("powerup"); },
    scheduleRaceDirtyStreamWorker() { calls.push("dirty"); },
    scheduleNotificationDeliveryStreamWorker() { calls.push("notification"); },
  }));

  assert.ok(calls.includes("billing"));
  assert.ok(calls.includes("trim"));
  assert.ok(calls.includes("global-events"));
  for (const forbidden of [
    "hydrate", "boundary-scheduler", "boundary-worker",
    "step", "powerup", "dirty", "notification",
  ]) {
    assert.equal(calls.includes(forbidden), false, `${forbidden} must not run in cron`);
  }
});
