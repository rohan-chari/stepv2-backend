const assert = require("node:assert/strict");
const test = require("node:test");
const {
  scheduleDomainEventProjection,
} = require("../../src/modules/domainEvents/jobs/domainEventProjection");

const {
  buildDomainEventProjectionJob,
} = require("../../src/modules/domainEvents/jobs/domainEventProjection");

test("domain event projection health checks never scan legacy history", async () => {
  let current = new Date("2026-09-02T12:00:00.000Z");
  const calls = { project: 0, health: 0, counters: 0, receipts: 0 };
  const run = buildDomainEventProjectionJob({
    now: () => current,
    projector: { run: async () => { calls.project += 1; return { processed: 0 }; } },
    getHealth: async () => {
      calls.health += 1;
      return {
        oldestEvent: null,
        oldestProjection: null,
        pendingByType: [],
        projectionsByStatus: [],
        downstream: {},
        terminalFailures: { events: 0, projections: 0 },
      };
    },
    reconcileProjectionCounters: async () => {
      calls.counters += 1;
      throw new Error("legacy counter reconciliation entered live projection loop");
    },
    reconcileEventReceipts: async () => {
      calls.receipts += 1;
      throw new Error("legacy receipt reconciliation entered live projection loop");
    },
    logger: { log() {}, error() {} },
  });

  await run();
  current = new Date(current.getTime() + 10_000);
  await run();
  current = new Date(current.getTime() + 50_000);
  await run();

  assert.deepEqual(calls, { project: 3, health: 2, counters: 0, receipts: 0 });
});

test("domain projection drain failures reach the coordinator and rearm no sooner than one second", async () => {
  const delays = [];
  const scheduler = scheduleDomainEventProjection({
    run: async () => { throw new Error("database unavailable"); },
    nextDueAt: async () => new Date(0),
    subscribeWake: async () => async () => {},
    setDueTimer(handler, delay) {
      delays.push(delay);
      return { handler, unref() {} };
    },
    clearDueTimer() {},
    logger: { log() {}, error() {} },
  });
  await new Promise((resolve) => setImmediate(resolve));
  assert.ok(delays.some((delay) => delay === 1_000));
  assert.ok(delays.every((delay) => delay >= 1_000));
  await scheduler.stop();
});
