const assert = require("node:assert/strict");
const test = require("node:test");

const { startServer } = require("../../src/index");

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
    cronStartDelayMs: 0,
    registerEventHandlers() {
      registerCalls += 1;
    },
    registerNotificationHandlers() {},
    scheduleRaceExpiryCheck: track("raceExpiry"),
    scheduleSeededRaceRenewal: track("seededRenewal"),
    scheduleComputeRanks: track("computeRanks"),
    scheduleComputeRankedWeeks: track("computeRankedWeeks"),
    scheduleGlobalStepEvents: track("globalStepEvents"),
    scheduleAutoStartScheduledRaces: track("autoStartScheduledRaces"),
    scheduleRecomputePlacements: track("recomputePlacements"),
    scheduleNotificationCleanup: track("notificationCleanup"),
    scheduleDailyMover: track("dailyMover"),
    logger: {
      log(message) {
        logs.push(message);
      },
    },
  });

  assert.equal(startedServer, server);
  assert.deepEqual(listenArgs.slice(0, 2), [3000, "0.0.0.0"]);
  assert.equal(registerCalls, 1);
  // Each scheduler is invoked exactly once on listen (kill-switch env vars unset
  // in tests, so the gated jobs run too).
  assert.deepEqual(scheduleCalls, {
    raceExpiry: 1,
    seededRenewal: 1,
    computeRanks: 1,
    computeRankedWeeks: 1,
    globalStepEvents: 1,
    autoStartScheduledRaces: 1,
    recomputePlacements: 1,
    notificationCleanup: 1,
    dailyMover: 1,
  });
  assert.deepEqual(logs, ["Steps Tracker API running on 0.0.0.0:3000"]);
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
    registerEventHandlers() {},
    registerNotificationHandlers() {},
    scheduleRaceExpiryCheck: track("raceExpiry"),
    scheduleSeededRaceRenewal: track("seededRenewal"),
    scheduleComputeRanks: track("computeRanks"),
    scheduleComputeRankedWeeks: track("computeRankedWeeks"),
    scheduleGlobalStepEvents: track("globalStepEvents"),
    scheduleAutoStartScheduledRaces: track("autoStartScheduledRaces"),
    scheduleRecomputePlacements: track("recomputePlacements"),
    scheduleNotificationCleanup: track("notificationCleanup"),
    scheduleDailyMover: track("dailyMover"),
    logger: {
      log(message) {
        logs.push(message);
      },
    },
  });

  // Immediately after listen: server is up, but no cron has been scheduled yet.
  assert.deepEqual(scheduleCalls, {});
  assert.ok(logs.some((l) => l.includes("Job scheduling starts in")));

  await new Promise((resolve) => setTimeout(resolve, 60));
  assert.equal(scheduleCalls.seededRenewal, 1);
  assert.equal(scheduleCalls.raceExpiry, 1);
  assert.equal(scheduleCalls.dailyMover, 1);
});
