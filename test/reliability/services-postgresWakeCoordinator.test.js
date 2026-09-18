const assert = require("node:assert/strict");
const test = require("node:test");

const {
  createPostgresWakeCoordinator,
} = require("../../src/shared/queues/postgresWakeCoordinator");

for (const [queue, fallbackIntervalMs] of [
  ["resolution", 5_000],
  ["placement", 10_000],
  ["post-task", 30_000],
  ["domain-event", 10_000],
  ["summary", 60_000],
]) {
  test(`healthy ${queue} wake drains immediately without its ${fallbackIntervalMs}ms recovery timer`, async () => {
    let subscriber;
    let drains = 0;
    const coordinator = createPostgresWakeCoordinator({
      queue,
      fallbackIntervalMs,
      drain: async () => { drains += 1; return false; },
      nextDueAt: async () => null,
      subscribeWake: async (handler) => {
        subscriber = handler;
        return async () => {};
      },
      logger: { error() {} },
    });

    try {
      await coordinator.start({ drainOnStart: false });
      assert.equal(drains, 0);
      subscriber({ queue });
      await coordinator.whenIdle();
      assert.equal(drains, 1);
    } finally {
      await coordinator.stop();
    }
  });
}

test("duplicate wakes coalesce while one drain owns the process", async () => {
  let subscriber;
  let release;
  let drains = 0;
  const held = new Promise((resolve) => { release = resolve; });
  const coordinator = createPostgresWakeCoordinator({
    queue: "resolution",
    fallbackIntervalMs: 5_000,
    drain: async () => {
      drains += 1;
      if (drains === 1) await held;
      return false;
    },
    nextDueAt: async () => null,
    subscribeWake: async (handler) => {
      subscriber = handler;
      return async () => {};
    },
    logger: { error() {} },
  });

  try {
    await coordinator.start({ drainOnStart: false });
    subscriber({ queue: "resolution" });
    subscriber({ queue: "resolution" });
    subscriber({ queue: "resolution" });
    release();
    await coordinator.whenIdle();
    assert.equal(drains, 2, "one active drain plus one coalesced follow-up");
  } finally {
    release();
    await coordinator.stop();
  }
});

test("a queued fallback recovery is not downgraded by a later Redis wake", async () => {
  let release;
  let started;
  const held = new Promise((resolve) => { release = resolve; });
  const firstStarted = new Promise((resolve) => { started = resolve; });
  const reasons = [];
  const coordinator = createPostgresWakeCoordinator({
    queue: "summary",
    fallbackIntervalMs: 60_000,
    drain: async ({ reason }) => {
      reasons.push(reason);
      if (reasons.length === 1) { started(); await held; }
    },
    nextDueAt: async () => null,
    subscribeWake: async () => async () => {},
    logger: { error() {} },
  });
  try {
    await coordinator.start({ drainOnStart: false });
    coordinator.requestDrain("due");
    await firstStarted;
    coordinator.requestDrain("fallback");
    coordinator.requestDrain("wake");
    release();
    await coordinator.whenIdle();
    assert.deepEqual(reasons, ["due", "fallback"]);
  } finally {
    release();
    await coordinator.stop();
  }
});

test("a wake arriving while next-due is being rearmed is drained before idle", async () => {
  let subscriber;
  let releaseDueLookup;
  let signalDueLookup;
  let drains = 0;
  const dueLookupHeld = new Promise((resolve) => { releaseDueLookup = resolve; });
  const dueLookupStarted = new Promise((resolve) => { signalDueLookup = resolve; });
  const coordinator = createPostgresWakeCoordinator({
    queue: "resolution",
    fallbackIntervalMs: 60_000,
    drain: async () => { drains += 1; },
    nextDueAt: async () => {
      if (drains === 1) {
        signalDueLookup();
        await dueLookupHeld;
      }
      return null;
    },
    subscribeWake: async (handler) => {
      subscriber = handler;
      return async () => {};
    },
    logger: { error() {} },
  });

  try {
    await coordinator.start({ drainOnStart: false });
    subscriber({ queue: "resolution" });
    await dueLookupStarted;
    subscriber({ queue: "resolution" });
    releaseDueLookup();
    await coordinator.whenIdle();
    assert.equal(drains, 2, "the rearm-window wake must not wait for fallback polling");
  } finally {
    releaseDueLookup();
    await coordinator.stop();
  }
});

test("a lost wake is recovered by the PostgreSQL fallback timer", async () => {
  let drains = 0;
  const coordinator = createPostgresWakeCoordinator({
    queue: "summary",
    fallbackIntervalMs: 10,
    drain: async () => { drains += 1; return false; },
    nextDueAt: async () => null,
    subscribeWake: async () => async () => {},
    logger: { error() {} },
  });

  try {
    await coordinator.start({ drainOnStart: false });
    const deadline = Date.now() + 500;
    while (drains === 0 && Date.now() < deadline) {
      await new Promise((resolve) => setTimeout(resolve, 5));
    }
    assert.ok(drains >= 1);
  } finally {
    await coordinator.stop();
  }
});

test("future work arms an exact due timer and is not claimed early", async () => {
  let drains = 0;
  let due = new Date(Date.now() + 25);
  const coordinator = createPostgresWakeCoordinator({
    queue: "notification-schedule",
    fallbackIntervalMs: 60_000,
    drain: async () => { drains += 1; due = null; return false; },
    nextDueAt: async () => due,
    subscribeWake: async () => async () => {},
    logger: { error() {} },
  });

  try {
    await coordinator.start({ drainOnStart: false });
    await coordinator.rearmDueTimer();
    assert.equal(drains, 0);
    const deadline = Date.now() + 500;
    while (drains === 0 && Date.now() < deadline) {
      await new Promise((resolve) => setTimeout(resolve, 5));
    }
    assert.equal(drains, 1);
  } finally {
    await coordinator.stop();
  }
});

test("persistent next-due lookup failures rearm with at least one second backoff", async () => {
  const delays = [];
  const coordinator = createPostgresWakeCoordinator({
    queue: "resolution",
    fallbackIntervalMs: 60_000,
    drain: async () => {},
    nextDueAt: async () => { throw new Error("database unavailable"); },
    subscribeWake: async () => async () => {},
    setTimer(handler, delay) {
      delays.push(delay);
      return { handler, unref() {} };
    },
    clearTimer() {},
    logger: { error() {} },
  });
  try {
    await coordinator.start({ drainOnStart: false });
    assert.ok(delays.some((delay) => delay >= 1_000));
  } finally {
    await coordinator.stop();
  }
});

test("a failing drain with a persistent past-due row never rearms at zero delay", async () => {
  const delays = [];
  let drains = 0;
  const coordinator = createPostgresWakeCoordinator({
    queue: "domain-event",
    fallbackIntervalMs: 60_000,
    drain: async () => { drains += 1; throw new Error("database unavailable"); },
    nextDueAt: async () => new Date(0),
    subscribeWake: async () => async () => {},
    setTimer(handler, delay) {
      delays.push(delay);
      return { handler, unref() {} };
    },
    clearTimer() {},
    logger: { error() {} },
  });
  try {
    await coordinator.start({ drainOnStart: true });
    assert.equal(drains, 1);
    assert.ok(delays.every((delay) => delay >= 1_000));
  } finally {
    await coordinator.stop();
  }
});
