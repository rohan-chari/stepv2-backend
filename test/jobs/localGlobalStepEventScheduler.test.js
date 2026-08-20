const assert = require("node:assert/strict");
const test = require("node:test");

const {
  buildLocalGlobalStepEventTick,
} = require("../../src/modules/steps/jobs/globalStepEventScheduler");

test("local scheduler is permanently enabled and retired controls cannot disable it", async () => {
  let creations = 0;
  const base = {
    now: () => new Date("2026-08-19T00:00:00Z"),
    GlobalStepEvent: { async createLocalParentIfAbsent() { creations += 1; } },
    appSettings: { async getFlag() { return false; } },
    materializeEntitlementsForActiveRacers: async () => 0,
    processDueEntitlementBoundaries: async () => {},
    captureOperationalSnapshot: async () => ({ healthy: true }),
    cleanupExpiredEntitlements: async () => 0,
    cronOwnerGuard: async () => true,
    logger: { log() {}, error() {} },
  };
  assert.equal(await buildLocalGlobalStepEventTick(base)(), true);
  assert.equal(creations, 2);

  const prior = process.env.LOCAL_GLOBAL_STEP_EVENTS_DISABLED;
  process.env.LOCAL_GLOBAL_STEP_EVENTS_DISABLED = "true";
  try {
    assert.equal(await buildLocalGlobalStepEventTick({
      ...base,
      appSettings: { async getFlag() { return true; } },
    })(), true);
    assert.equal(creations, 4);
  } finally {
    if (prior === undefined) delete process.env.LOCAL_GLOBAL_STEP_EVENTS_DISABLED;
    else process.env.LOCAL_GLOBAL_STEP_EVENTS_DISABLED = prior;
  }
});

test("local scheduler materializes exactly two future logical days and their active racers", async () => {
  const createdDays = [];
  const materialized = [];
  const run = buildLocalGlobalStepEventTick({
    now: () => new Date("2026-08-19T00:00:00Z"),
    appSettings: { async getFlag(key) {
      return key === "localGlobalStepEventsEnabled" ||
        key === "localGlobalStepEventRetentionEnabled";
    } },
    cronOwnerGuard: async () => true,
    GlobalStepEvent: {
      async createLocalParentIfAbsent({ eventDay }) {
        createdDays.push(eventDay);
        return { created: true, event: { id: `event-${eventDay}`, eventDay } };
      },
    },
    materializeEntitlementsForActiveRacers: async (event) => materialized.push(event.id),
    processDueEntitlementBoundaries: async () => ({ starts: 0, ends: 0 }),
    captureOperationalSnapshot: async () => ({ healthy: true }),
    cleanupExpiredEntitlements: async () => 0,
    logger: { log() {}, error() {} },
  });

  assert.equal(await run(), true);
  assert.equal(createdDays.length, 2);
  assert.deepEqual(materialized, createdDays.map((day) => `event-${day}`));
});

test("retired creation switches never stop maintenance or permanent creation", async () => {
  const calls = [];
  const existing = { id: "existing", scheduleMode: "LOCAL_ENTITLEMENTS" };
  const run = buildLocalGlobalStepEventTick({
    now: () => new Date("2026-08-19T00:00:00Z"),
    appSettings: { async getFlag() { return false; } },
    cronOwnerGuard: async () => true,
    GlobalStepEvent: {
      async findLocalParentsForMaintenance() { calls.push("find"); return [existing]; },
      async createLocalParentIfAbsent() { calls.push("create"); },
    },
    materializeEntitlementsForActiveRacers: async (event) => {
      calls.push(`materialize:${event.id}`);
      return 0;
    },
    processDueEntitlementBoundaries: async () => { calls.push("boundaries"); },
    captureOperationalSnapshot: async () => ({ healthy: true }),
    cleanupExpiredEntitlements: async () => 0,
    logger: { log() {}, error() {} },
  });

  assert.equal(await run(), true);
  assert.deepEqual(calls, ["boundaries", "find", "materialize:existing", "create", "create"]);
});

test("due boundary claims are prioritized before materialization and creation", async () => {
  const calls = [];
  const run = buildLocalGlobalStepEventTick({
    now: () => new Date("2026-08-19T00:00:00Z"),
    appSettings: { async getFlag() { return true; } },
    cronOwnerGuard: async () => true,
    GlobalStepEvent: {
      async findLocalParentsForMaintenance() { calls.push("find"); return []; },
      async createLocalParentIfAbsent({ eventDay }) {
        calls.push(`create:${eventDay}`);
        return { created: true, event: { id: eventDay } };
      },
    },
    materializeEntitlementsForActiveRacers: async (event) => {
      calls.push(`materialize:${event.id}`);
      return 0;
    },
    processDueEntitlementBoundaries: async () => { calls.push("boundaries"); },
    captureOperationalSnapshot: async () => ({ healthy: true }),
    cleanupExpiredEntitlements: async () => 0,
    logger: { log() {}, error() {} },
  });

  await run();
  assert.equal(calls[0], "boundaries");
  assert.ok(calls.findIndex((entry) => entry.startsWith("create:")) > 0);
});

test("local creation is rejected while any durable cron owner is not local-aware", async () => {
  let creations = 0;
  const run = buildLocalGlobalStepEventTick({
    now: () => new Date("2026-08-19T00:00:00Z"),
    appSettings: { async getFlag() { return true; } },
    cronOwnerGuard: async () => false,
    GlobalStepEvent: {
      async findLocalParentsForMaintenance() { return []; },
      async createLocalParentIfAbsent() { creations += 1; },
    },
    materializeEntitlementsForActiveRacers: async () => 0,
    processDueEntitlementBoundaries: async () => {},
    captureOperationalSnapshot: async () => ({ healthy: true }),
    cleanupExpiredEntitlements: async () => 0,
    logger: { log() {}, error() {} },
  });
  assert.equal(await run(), false);
  assert.equal(creations, 0);
});

test("local creation permanently runs retention before creating parents", async () => {
  let creations = 0;
  const run = buildLocalGlobalStepEventTick({
    now: () => new Date("2026-08-19T00:00:00Z"),
    appSettings: { async getFlag(key) { return key === "localGlobalStepEventsEnabled"; } },
    cronOwnerGuard: async () => true,
    GlobalStepEvent: {
      async findLocalParentsForMaintenance() { return []; },
      async createLocalParentIfAbsent() { creations += 1; },
    },
    materializeEntitlementsForActiveRacers: async () => 0,
    processDueEntitlementBoundaries: async () => {},
    captureOperationalSnapshot: async () => ({ healthy: true }),
    cleanupExpiredEntitlements: async () => 0,
    logger: { log() {}, error() {} },
  });
  assert.equal(await run(), true);
  assert.equal(creations, 2);
});

test("maintenance drains more than one hundred missing racer entitlements", async () => {
  const batches = [100, 100, 37, 0];
  let materialized = 0;
  const run = buildLocalGlobalStepEventTick({
    now: () => new Date("2026-08-19T00:00:00Z"),
    appSettings: { async getFlag() { return false; } },
    GlobalStepEvent: {
      async findLocalParentsForMaintenance() {
        return [{ id: "existing", scheduleMode: "LOCAL_ENTITLEMENTS" }];
      },
    },
    materializeEntitlementsForActiveRacers: async () => {
      const count = batches.shift();
      materialized += count;
      return count;
    },
    processDueEntitlementBoundaries: async () => {},
    captureOperationalSnapshot: async () => ({ healthy: true }),
    cleanupExpiredEntitlements: async () => 0,
    logger: { log() {}, error() {} },
  });

  await run();
  assert.equal(materialized, 237);
  assert.deepEqual(batches, [0]);
});

test("maintenance advances a candidate cursor when a full page creates nothing", async () => {
  const cursors = [];
  const pages = [
    { candidates: 100, created: 0, nextCursor: "user-099", exhausted: false },
    { candidates: 50, created: 40, nextCursor: "user-149", exhausted: true },
  ];
  const run = buildLocalGlobalStepEventTick({
    now: () => new Date("2026-08-19T00:00:00Z"),
    appSettings: { async getFlag() { return false; } },
    GlobalStepEvent: {
      async findLocalParentsForMaintenance() {
        return [{ id: "existing", scheduleMode: "LOCAL_ENTITLEMENTS" }];
      },
    },
    materializeEntitlementsForActiveRacers: async (_event, options) => {
      cursors.push(options.afterUserId || null);
      return pages.shift();
    },
    processDueEntitlementBoundaries: async () => {},
    captureOperationalSnapshot: async () => ({ healthy: true }),
    cleanupExpiredEntitlements: async () => 0,
    logger: { log() {}, error() {} },
  });

  await run();
  assert.deepEqual(cursors, [null, "user-099"]);
  assert.deepEqual(pages, []);
});
