const assert = require("node:assert/strict");
const test = require("node:test");

const {
  scheduleRaceResolutionWorkerV2,
} = require("../../src/modules/races/jobs/raceResolutionQueueV2");

test("one wake drains every immediately eligible page when adaptive drain is disabled", async () => {
  let remaining = 0;
  let ticks = 0;
  let wake = null;
  const scheduled = scheduleRaceResolutionWorkerV2({
    nodeEnv: "test",
    processRole: "resolution",
    worker: {
      async tick() {
        ticks += 1;
        if (remaining === 0) return 0;
        remaining -= 1;
        return 1;
      },
      async logQueueLag() {},
    },
    appSettings: { async getFlag() { return false; } },
    RaceResolutionJobV2: {
      async nextDueAt() { return remaining > 0 ? new Date() : null; },
    },
    StepSyncRequest: { async cleanupExpired() {} },
    subscribeWake: async (handler) => { wake = handler; return async () => {}; },
    drainOnStart: false,
    logger: { log() {}, error() {} },
    pollIntervalMs: 5_000,
  });
  while (!wake) await new Promise((resolve) => setImmediate(resolve));
  remaining = 3;
  wake({ queue: "resolution" });
  while (remaining > 0 || ticks < 3) {
    await new Promise((resolve) => setImmediate(resolve));
  }
  await scheduled.coordinator.whenIdle();
  // Each bounded tick handles one page. Exact-due rearming supplies immediate
  // continuation without waiting for the five-second recovery cadence.
  assert.equal(remaining, 0);
  assert.equal(ticks, 3);
  await scheduled.stop();
});

test("startup quiet schedules one due check at the readiness boundary instead of spinning", async () => {
  const timers = [];
  let dueReads = 0;
  const scheduled = scheduleRaceResolutionWorkerV2({
    nodeEnv: "test",
    processRole: "resolution",
    worker: {
      startupReadiness() {
        return { ready: false, quietPeriodElapsed: false, remainingQuietMs: 60_000 };
      },
      async tick() { return 0; },
      async logQueueLag() {},
    },
    RaceResolutionJobV2: {
      async nextDueAt() { dueReads += 1; return new Date(0); },
    },
    StepSyncRequest: { async cleanupExpired() {} },
    subscribeWake: async () => async () => {},
    drainOnStart: false,
    setDueTimer(fn, delay) {
      timers.push({ fn, delay });
      return { unref() {} };
    },
    clearDueTimer() {},
    logger: { log() {}, error() {} },
    pollIntervalMs: 5_000,
  });

  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(dueReads, 0, "the queue must not be queried during startup quiet");
  assert.equal(timers.at(-1)?.delay, 60_000);
  await scheduled.stop();
});

test("adaptive draining promotes FULL triggers once per wake, not once per claimed race", async () => {
  let wake = null;
  let remaining = 3;
  let promotions = 0;
  let beginDrains = 0;
  let releaseFirstTick;
  const firstTickGate = new Promise((resolve) => { releaseFirstTick = resolve; });
  let ticks = 0;
  const scheduled = scheduleRaceResolutionWorkerV2({
    nodeEnv: "test",
    processRole: "resolution",
    worker: {
      beginDrain() { beginDrains += 1; },
      async tick() {
        ticks += 1;
        if (ticks === 1) await firstTickGate;
        if (remaining === 0) return 0;
        remaining -= 1;
        return 1;
      },
      async logQueueLag() {},
    },
    appSettings: { async getFlag() { return true; } },
    RaceResolutionJobV2: { async nextDueAt() { return null; } },
    StepSyncRequest: { async cleanupExpired() {} },
    subscribeWake: async (handler) => { wake = handler; return async () => {}; },
    drainOnStart: false,
    logger: { log() {}, error() {} },
    pollIntervalMs: 5_000,
  });
  scheduled.worker.beginDrain = () => {
    beginDrains += 1;
    promotions += 1;
  };
  while (!wake) await new Promise((resolve) => setImmediate(resolve));
  wake({ queue: "resolution" });
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(beginDrains, 1);
  wake({ queue: "resolution" });
  assert.equal(
    beginDrains,
    2,
    "a healthy Redis wake must re-arm promotion while a drain is still active",
  );
  releaseFirstTick();
  await scheduled.coordinator.whenIdle();
  assert.equal(remaining, 0);
  assert.equal(beginDrains, 2);
  assert.equal(promotions, 2);
  await scheduled.stop();
});

test("fallback recovery re-arms FULL-trigger promotion during a saturated drain", async () => {
  let wake = null;
  let releaseTick;
  const tickGate = new Promise((resolve) => { releaseTick = resolve; });
  const timers = [];
  let beginDrains = 0;
  const scheduled = scheduleRaceResolutionWorkerV2({
    nodeEnv: "test",
    processRole: "resolution",
    worker: {
      beginDrain() { beginDrains += 1; },
      async tick() { await tickGate; return 0; },
      async logQueueLag() {},
    },
    appSettings: { async getFlag() { return true; } },
    RaceResolutionJobV2: { async nextDueAt() { return null; } },
    StepSyncRequest: { async cleanupExpired() {} },
    subscribeWake: async (handler) => { wake = handler; return async () => {}; },
    drainOnStart: false,
    setDueTimer(fn, delay) {
      const timer = { fn, delay, unref() {} };
      timers.push(timer);
      return timer;
    },
    clearDueTimer() {},
    logger: { log() {}, error() {} },
    pollIntervalMs: 5_000,
  });
  while (!wake) await new Promise((resolve) => setImmediate(resolve));
  wake({ queue: "resolution" });
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(beginDrains, 1);
  const fallback = timers.find((timer) => timer.delay === 5_000);
  assert.ok(fallback);
  fallback.fn();
  assert.equal(
    beginDrains,
    2,
    "the PostgreSQL recovery signal must re-arm promotion before saturation ends",
  );
  releaseTick();
  await scheduled.coordinator.whenIdle();
  await scheduled.stop();
});

test("classified ordinary wakes drain resolution work without scanning FULL triggers", async () => {
  let wake = null;
  let beginDrains = 0;
  const scheduled = scheduleRaceResolutionWorkerV2({
    nodeEnv: "test",
    processRole: "resolution",
    worker: {
      beginDrain() { beginDrains += 1; },
      async tick() { return 0; },
      async logQueueLag() {},
    },
    appSettings: { async getFlag() { return true; } },
    RaceResolutionJobV2: { async nextDueAt() { return null; } },
    StepSyncRequest: { async cleanupExpired() {} },
    subscribeWake: async (handler) => { wake = handler; return async () => {}; },
    drainOnStart: false,
    logger: { log() {}, error() {} },
    pollIntervalMs: 5_000,
  });
  while (!wake) await new Promise((resolve) => setImmediate(resolve));

  wake({ queue: "resolution", workKind: "ordinary" });
  await scheduled.coordinator.whenIdle();

  assert.equal(beginDrains, 0);
  await scheduled.stop();
});

test("classified FULL and legacy wakes conservatively scan FULL triggers", async () => {
  let wake = null;
  let beginDrains = 0;
  const scheduled = scheduleRaceResolutionWorkerV2({
    nodeEnv: "test",
    processRole: "resolution",
    worker: {
      beginDrain() { beginDrains += 1; },
      async tick() { return 0; },
      async logQueueLag() {},
    },
    appSettings: { async getFlag() { return true; } },
    RaceResolutionJobV2: { async nextDueAt() { return null; } },
    StepSyncRequest: { async cleanupExpired() {} },
    subscribeWake: async (handler) => { wake = handler; return async () => {}; },
    drainOnStart: false,
    logger: { log() {}, error() {} },
    pollIntervalMs: 5_000,
  });
  while (!wake) await new Promise((resolve) => setImmediate(resolve));

  wake({ queue: "resolution", workKind: "full-trigger" });
  await scheduled.coordinator.whenIdle();
  wake({ queue: "resolution" });
  await scheduled.coordinator.whenIdle();

  assert.equal(beginDrains, 2);
  await scheduled.stop();
});
