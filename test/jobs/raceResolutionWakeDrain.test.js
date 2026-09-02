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
