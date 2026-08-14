const assert = require("node:assert/strict");
const test = require("node:test");
const { startServer } = require("../../src/index");

const noopSchedulers = {
  scheduleRaceExpiryCheck() {},
  scheduleSeededRaceRenewal() {},
  scheduleTournamentSeedRenewal() {},
  scheduleComputeRanks() {},
  scheduleComputeRankedWeeks() {},
  scheduleGlobalStepEvents() {},
  scheduleAutoStartScheduledRaces() {},
  scheduleRecomputePlacements() {},
  scheduleNotificationCleanup() {},
  scheduleActivationEventCleanup() {},
  scheduleDailyMover() {},
  scheduleRaceResolutionPostTasks() {},
};

function fakeApp() {
  return {
    listen(...args) {
      args[2]();
      return { close() {} };
    },
  };
}

test("startServer registers the race-resolution worker after the cron delay", async () => {
  let workerCalls = 0;
  startServer({
    app: fakeApp(),
    port: 3000,
    cronStartDelayMs: 20,
    registerEventHandlers() {},
    registerNotificationHandlers() {},
    ...noopSchedulers,
    scheduleRaceResolutionWorker() {
      workerCalls += 1;
    },
    logger: { log() {} },
  });

  // Deferred past the reload-overlap window like the other jobs.
  assert.equal(workerCalls, 0);
  await new Promise((r) => setTimeout(r, 60));
  assert.equal(workerCalls, 1);
});

test("worker is registered immediately when cronStartDelayMs is 0", () => {
  let workerCalls = 0;
  startServer({
    app: fakeApp(),
    port: 3000,
    cronStartDelayMs: 0,
    registerEventHandlers() {},
    registerNotificationHandlers() {},
    ...noopSchedulers,
    scheduleRaceResolutionWorker() {
      workerCalls += 1;
    },
    logger: { log() {} },
  });
  assert.equal(workerCalls, 1);
});
