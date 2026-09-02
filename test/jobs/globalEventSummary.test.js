const assert = require("node:assert/strict");
const test = require("node:test");

const {
  buildGlobalEventSummaryTick,
  nextSummaryDueAt,
  scheduleGlobalEventSummaryTick,
} = require("../../src/modules/steps/jobs/globalEventSummary");

test("summary exact-due scheduling excludes recovery deadlines owned by the fallback sweep", async () => {
  let sql = null;
  const dueAt = await nextSummaryDueAt({
    async $queryRawUnsafe(statement) {
      sql = statement;
      return [{ dueAt: null }];
    },
  });
  assert.equal(dueAt, null);
  assert.doesNotMatch(sql, /next_recovery_at/i);
  assert.match(sql, /status='WAITING_SYNC'/i);
  assert.doesNotMatch(sql, /GREATEST\(/i);
  assert.match(sql, /MIN\(available_at\)[\s\S]*status='WAITING_RACES'[\s\S]*lease_until IS NULL/i);
  assert.match(sql, /MIN\(lease_until\)[\s\S]*status='WAITING_RACES'[\s\S]*available_at <= CURRENT_TIMESTAMP/i);
  assert.match(sql, /MIN\(expires_at\)[\s\S]*status='WAITING_SYNC'[\s\S]*lease_until IS NULL/i);
  assert.match(sql, /MIN\(lease_until\)[\s\S]*status='WAITING_SYNC'[\s\S]*expires_at <= CURRENT_TIMESTAMP/i);
});

test("leased WAITING_RACES and WAITING_SYNC work rearm at the lease, never their past boundary", async () => {
  const now = new Date("2026-09-02T12:00:00.000Z");
  const leaseUntil = new Date(now.getTime() + 15_000);
  const dueAt = await nextSummaryDueAt({
    async $queryRawUnsafe(sql) {
      assert.match(sql, /MIN\(lease_until\)/);
      assert.doesNotMatch(sql, /GREATEST\(/);
      return [{ dueAt: leaseUntil }];
    },
  });
  assert.equal(dueAt.getTime(), leaseUntil.getTime());
  assert.ok(dueAt > now);
});

test("an overdue recovery deadline runs only on fallback and cannot re-arm a zero-delay due loop", async () => {
  const calls = [];
  const scheduler = scheduleGlobalEventSummaryTick({
    runV1Tick: async () => ({ candidatesSelected: 0, batchLimitSaturated: false }),
    runV2Tick: async (options) => { calls.push(options); return { candidatesSelected: 0 }; },
    setInterval() { return { unref() {} }; },
    clearInterval() {},
    setTimeout() { return { unref() {} }; },
    clearTimeout() {},
    logger: { log() {}, error() {} },
  });
  await new Promise((resolve) => setImmediate(resolve));
  await scheduler.tickV2({ reason: "due" });
  await scheduler.tickV2({ reason: "fallback" });
  assert.equal(calls.some((call) => call.recovery === true), true);
  assert.equal(calls.filter((call) => call.recovery === true).length, 1);
  await scheduler.stop();
});

test("production summary drain failures reach the coordinator's one-second clamp", async () => {
  const delays = [];
  const scheduler = scheduleGlobalEventSummaryTick({
    runV1Tick: async () => ({ candidatesSelected: 0 }),
    runV2Tick: async () => { throw new Error("database unavailable"); },
    nextDueAt: async () => new Date(0),
    subscribeWake: async () => async () => {},
    setDueTimer(handler, delay) {
      delays.push(delay);
      return { handler, unref() {} };
    },
    clearDueTimer() {},
    setTimeout() { return { unref() {} }; },
    clearTimeout() {},
    logger: { log() {}, error() {} },
  });
  await new Promise((resolve) => setImmediate(resolve));
  assert.ok(delays.some((delay) => delay === 1_000));
  assert.ok(delays.every((delay) => delay >= 1_000));
  await scheduler.stop();
});

function summaryPrisma({ endsAt, pending = 0, nonzero = 1, sum = 12, count = 1 }) {
  const writes = [];
  return {
    writes,
    async $queryRawUnsafe(_sql, current) {
      if (new Date(endsAt).getTime() > new Date(current).getTime() || pending) return [];
      return [{
        eventId: "event-1",
        userId: "user-1",
        deltaSteps: BigInt(sum),
        raceCount: BigInt(count),
        nonzeroCount: BigInt(nonzero),
      }];
    },
    globalEventRaceImpact: {
      async groupBy() {
        return [{
          eventId: "event-1",
          userId: "user-1",
          _sum: { deltaSteps: sum },
          _count: { _all: count },
        }];
      },
      async count({ where }) {
        return where?.deltaSteps ? nonzero : pending;
      },
    },
    globalStepEvent: {
      async findUnique() { return { endsAt }; },
    },
    async $transaction(write) {
      return write({
        jobRun: { async create(input) { writes.push({ kind: "job", input }); } },
        globalEventUserSummary: { async upsert(input) { writes.push({ kind: "summary", input }); } },
      });
    },
  };
}

test("global recap waits until the event enrollment window has closed", async () => {
  const current = new Date("2026-08-17T12:00:00.000Z");
  const prisma = summaryPrisma({ endsAt: new Date("2026-08-17T12:01:00.000Z") });
  const tick = buildGlobalEventSummaryTick({ prisma, now: () => current });

  assert.deepEqual(await tick(), { upserts: 0 });
  assert.deepEqual(prisma.writes, []);
});

test("closed events still require every durable enrollment to settle", async () => {
  const current = new Date("2026-08-17T12:00:00.000Z");
  const prisma = summaryPrisma({
    endsAt: new Date("2026-08-17T11:59:59.000Z"), pending: 1,
  });
  const tick = buildGlobalEventSummaryTick({ prisma, now: () => current });

  assert.deepEqual(await tick(), { upserts: 0 });
  assert.deepEqual(prisma.writes, []);
});

test("all-zero final groups are durably claimed without creating a summary", async () => {
  const current = new Date("2026-08-17T12:00:00.000Z");
  const prisma = summaryPrisma({
    endsAt: new Date("2026-08-17T11:59:59.000Z"),
    nonzero: 0,
    sum: 0,
    count: 2,
  });
  const tick = buildGlobalEventSummaryTick({ prisma, now: () => current });

  assert.deepEqual(await tick(), { upserts: 0 });
  assert.equal(prisma.writes.length, 1);
  assert.equal(prisma.writes[0].kind, "job");
  assert.equal(prisma.writes[0].input.data.lastRanFor, "ALL_ZERO");
});

test("mixed nonzero contributions summing to zero still create the recap", async () => {
  const current = new Date("2026-08-17T12:00:00.000Z");
  const prisma = summaryPrisma({
    endsAt: new Date("2026-08-17T11:59:59.000Z"),
    nonzero: 2,
    sum: 0,
    count: 2,
  });
  const tick = buildGlobalEventSummaryTick({ prisma, now: () => current });

  assert.deepEqual(await tick(), { upserts: 1 });
  assert.deepEqual(prisma.writes.map((write) => write.kind), ["job", "summary"]);
  assert.equal(prisma.writes[0].input.data.lastRanFor, "FINAL");
  assert.equal(prisma.writes[1].input.create.extraRaceSteps, 0);
  assert.equal(prisma.writes[1].input.create.raceCount, 2);
});

test("v1 recap discovers only unfinished eligible groups in one bounded query", async () => {
  const current = new Date("2026-08-17T12:00:00.000Z");
  const writes = [];
  const queries = [];
  const prisma = {
    async $queryRawUnsafe(sql, ...params) {
      queries.push({ sql, params });
      return [{
        eventId: "event-1",
        userId: "user-1",
        deltaSteps: 12n,
        raceCount: 2n,
        nonzeroCount: 1n,
      }];
    },
    globalEventRaceImpact: {
      async groupBy() {
        throw new Error("v1 discovery must not rescan every historical group");
      },
    },
    async $transaction(write) {
      return write({
        jobRun: { async create(input) { writes.push({ kind: "job", input }); } },
        globalEventUserSummary: { async upsert(input) { writes.push({ kind: "summary", input }); } },
      });
    },
  };
  const tick = buildGlobalEventSummaryTick({
    prisma,
    now: () => current,
    v1BatchSize: 100,
  });

  assert.deepEqual(await tick(), { upserts: 1 });
  assert.equal(queries.length, 1);
  assert.match(queries[0].sql, /NOT EXISTS[\s\S]*FROM job_runs/i);
  assert.doesNotMatch(queries[0].sql, /MATERIALIZED/i);
  assert.ok(
    queries[0].sql.indexOf("NOT EXISTS") < queries[0].sql.indexOf("GROUP BY"),
    "the durable fence must narrow candidates before aggregation",
  );
  assert.ok(
    queries[0].sql.indexOf("event.ends_at") < queries[0].sql.indexOf("GROUP BY"),
    "event/enrollment closure must narrow candidates before aggregation",
  );
  assert.match(queries[0].sql, /LIMIT \$2/i);
  assert.deepEqual(queries[0].params, [current.toISOString(), 100]);
  assert.deepEqual(writes.map((write) => write.kind), ["job", "summary"]);
});

test("v2 keeps its one-second cadence while v1 adaptively backs off", async () => {
  const intervals = [];
  const timeouts = [];
  let v1Calls = 0;
  let v2Calls = 0;
  let releaseFirstV1;
  const firstV1 = new Promise((resolve) => { releaseFirstV1 = resolve; });
  const scheduler = scheduleGlobalEventSummaryTick({
    runV1Tick: async () => {
      v1Calls += 1;
      if (v1Calls === 1) await firstV1;
      return v1Calls === 1
        ? { candidatesSelected: 100, batchLimitSaturated: true }
        : { candidatesSelected: 0, batchLimitSaturated: false };
    },
    runV2Tick: async () => { v2Calls += 1; return { candidatesSelected: 0 }; },
    setInterval(fn, delay) { intervals.push({ fn, delay }); return { unref() {} }; },
    clearInterval() {},
    setTimeout(fn, delay) { timeouts.push({ fn, delay }); return { unref() {} }; },
    clearTimeout() {},
    logger: { log() {}, error() {} },
    v1BusyDelayMs: 250,
    v1IdleDelayMs: 45_000,
  });
  await new Promise((resolve) => setImmediate(resolve));

  assert.equal(v1Calls, 1);
  assert.equal(v2Calls, 1);
  assert.equal(intervals.length, 1);
  assert.equal(intervals[0].delay, 1000);
  await intervals[0].fn();
  assert.equal(v2Calls, 2, "v2 must continue while the first v1 drain is running");
  assert.equal(v1Calls, 1, "v1 must not overlap itself");

  releaseFirstV1();
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(timeouts.at(-1).delay, 250);
  await timeouts.at(-1).fn();
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(v1Calls, 2);
  assert.equal(timeouts.at(-1).delay, 45_000);
  await scheduler.stop();
});

test("summary scheduler shutdown waits for both phases and does not re-arm v1", async () => {
  let releaseV1;
  let releaseV2;
  const v1Pending = new Promise((resolve) => { releaseV1 = resolve; });
  const v2Pending = new Promise((resolve) => { releaseV2 = resolve; });
  const timeouts = [];
  const scheduler = scheduleGlobalEventSummaryTick({
    runV1Tick: async () => { await v1Pending; return { candidatesSelected: 0 }; },
    runV2Tick: async () => { await v2Pending; return { candidatesSelected: 0 }; },
    setInterval() { return { unref() {} }; },
    clearInterval() {},
    setTimeout(fn, delay) { timeouts.push({ fn, delay }); return { unref() {} }; },
    clearTimeout() {},
    logger: { log() {}, error() {} },
  });
  let stopped = false;
  const stopping = scheduler.stop().then(() => { stopped = true; });
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(stopped, false);

  releaseV1();
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(stopped, false, "shutdown must also await the active v2 tick");
  releaseV2();
  await stopping;

  assert.equal(stopped, true);
  assert.equal(timeouts.length, 0, "the completed v1 tick must not re-arm after stop");
});
