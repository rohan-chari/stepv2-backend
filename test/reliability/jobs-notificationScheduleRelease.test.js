const assert = require("node:assert/strict");
const test = require("node:test");

const {
  FALLBACK_INTERVAL_MS,
  scheduleNotificationScheduleRelease,
} = require("../../src/modules/notifications/jobs/notificationScheduleRelease");
const {
  buildNotificationIntentService,
} = require("../../src/modules/notifications/services/notificationDelivery");

test("schedule next-due probes normal and admission lanes independently", async () => {
  const calls = [];
  const service = buildNotificationIntentService({
    prisma: {
      notificationSchedule: {
        async findFirst(args) {
          calls.push(args);
          if (args.select.expiresAt) {
            return { expiresAt: new Date(args.where.status === "PENDING"
              ? "2026-09-02T12:00:30Z" : "2026-09-02T12:00:05Z") };
          }
          return { availableAt: new Date(args.where.status === "PENDING"
            ? "2026-09-02T12:00:20Z" : "2026-09-02T12:00:10Z") };
        },
      },
    },
  });
  assert.equal((await service.nextDueAt()).toISOString(), "2026-09-02T12:00:05.000Z");
  assert.deepEqual(calls.map((call) => call.where.status), [
    "PENDING", "PENDING", "ADMISSION_PENDING", "ADMISSION_PENDING",
  ]);
  assert.equal(calls[2].where.admissionClass, "visible:GLOBAL_EVENT_STARTED");
  assert.equal(calls[3].where.admissionClass, "visible:GLOBAL_EVENT_STARTED");
  assert.deepEqual(calls.map((call) => Object.keys(call.orderBy)[0]), [
    "availableAt", "expiresAt", "availableAt", "expiresAt",
  ]);
});

test("schedule release combines durable fallback polling with immediate wake hints", async () => {
  assert.equal(FALLBACK_INTERVAL_MS, 60_000);
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

test("schedule release arms the exact eligibility boundary with no polling floor", async () => {
  const delays = [];
  const timers = [];
  const job = scheduleNotificationScheduleRelease({
    run: async () => ({ released: 0 }),
    nextDueAt: async () => new Date(10_250),
    nowMs: () => 10_000,
    setDueTimer(handler, delay) {
      delays.push(delay);
      const timer = { handler, unref() {} };
      timers.push(timer);
      return timer;
    },
    clearDueTimer() {},
    subscribeNotificationWakeup: async () => async () => {},
    intervalMs: 60_000,
    logger: { error() {} },
  });
  try {
    await job.tick();
    assert.equal(delays.at(-1), 250);
  } finally {
    await job.stop();
  }
});

test("a wake after the final empty claim but before drain completion forces a rerun", async () => {
  let wake;
  let releaseSecond;
  let runs = 0;
  const held = new Promise((resolve) => { releaseSecond = resolve; });
  const job = scheduleNotificationScheduleRelease({
    run: async () => {
      runs += 1;
      if (runs === 2) await held;
      return { released: 0 };
    },
    nextDueAt: async () => null,
    subscribeNotificationWakeup: async (handler) => { wake = handler; return async () => {}; },
    intervalMs: 60_000,
    logger: { error() {} },
  });
  try {
    while (runs < 1) await new Promise((resolve) => setImmediate(resolve));
    const draining = job.tick();
    while (runs < 2) await new Promise((resolve) => setImmediate(resolve));
    wake();
    releaseSecond();
    await draining;
    assert.equal(runs, 3);
  } finally {
    releaseSecond();
    await job.stop();
  }
});

test("persistent schedule-release errors back off at least one second", async () => {
  const delays = [];
  const job = scheduleNotificationScheduleRelease({
    run: async () => { throw new Error("database unavailable"); },
    nextDueAt: async () => new Date(0),
    nowMs: () => 10_000,
    setDueTimer(handler, delay) {
      delays.push(delay);
      return { handler, unref() {} };
    },
    clearDueTimer() {},
    subscribeNotificationWakeup: async () => async () => {},
    intervalMs: 60_000,
    logger: { error() {} },
  });
  try {
    await job.tick();
    assert.ok(delays.some((delay) => delay >= 1_000));
  } finally {
    await job.stop();
  }
});
