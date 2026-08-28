const assert = require("node:assert/strict");
const test = require("node:test");

const {
  FALLBACK_INTERVAL_MS,
  scheduleNotificationScheduleRelease,
} = require("../../src/modules/notifications/jobs/notificationScheduleRelease");

test("schedule release combines durable fallback polling with immediate wake hints", async () => {
  assert.equal(FALLBACK_INTERVAL_MS, 5000);
  let wake = null;
  let runs = 0;
  const job = scheduleNotificationScheduleRelease({
    run: async () => { runs += 1; return { released: 0 }; },
    nextDueAt: async () => new Date(Date.now() + 60_000),
    subscribeNotificationWakeup: async (handler) => {
      wake = handler;
      return async () => {};
    },
    intervalMs: 60_000,
    logger: { error() {} },
  });
  try {
    await job.tick();
    assert.equal(typeof wake, "function");
    const beforeWake = runs;
    await wake();
    await new Promise((resolve) => setImmediate(resolve));
    assert.equal(runs, beforeWake + 1);
  } finally {
    await job.stop();
  }
});

test("durable fallback polling continues when the Redis wake subscription fails", async () => {
  let runs = 0;
  const errors = [];
  const job = scheduleNotificationScheduleRelease({
    run: async () => { runs += 1; return { released: 0 }; },
    nextDueAt: async () => null,
    subscribeNotificationWakeup: async () => {
      throw new Error("redis unavailable");
    },
    intervalMs: 10,
    logger: { error(message) { errors.push(message); } },
  });
  try {
    const deadline = Date.now() + 1_000;
    while (runs < 2 && Date.now() < deadline) {
      await new Promise((resolve) => setTimeout(resolve, 5));
    }
    assert.ok(runs >= 2, "startup and PostgreSQL fallback scans must both run");
    assert.equal(errors.length, 1);
  } finally {
    await job.stop();
  }
});
