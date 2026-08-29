const assert = require("node:assert/strict");
const { EventEmitter } = require("node:events");
const test = require("node:test");

const {
  HISTOGRAM_BOUNDARIES_MS,
  ENDPOINTS,
  OUTCOMES,
  PHASES,
  createHistogram,
  observeHistogram,
  mergeHistograms,
  histogramPercentile,
  createDatabasePoolTelemetry,
} = require("../../src/shared/observability/databasePoolTelemetry");

test("fixed histograms preserve all boundary observations and merge before p95", () => {
  assert.deepEqual(HISTOGRAM_BOUNDARIES_MS, [1, 5, 10, 25, 50, 100, 250, 500, 1000, 2500, 5000]);
  const left = createHistogram();
  for (const value of [0, 1, 5, 100, 5001]) observeHistogram(left, value);
  assert.equal(left.observations, 5);
  assert.equal(left.counts.length, 12);
  assert.equal(left.counts.at(-1), 5);
  assert.equal(left.maxMs, 5001);

  const right = createHistogram();
  for (let index = 0; index < 95; index += 1) observeHistogram(right, 10);
  const merged = mergeHistograms([left, right]);
  assert.equal(merged.observations, 100);
  assert.equal(histogramPercentile(merged, 0.95), 10);
});

test("pool instrumentation distinguishes queued checkout and physical connection failures", async () => {
  const pool = new EventEmitter();
  pool.options = { max: 20 };
  pool.totalCount = 20;
  pool.idleCount = 0;
  pool.waitingCount = 0;
  pool.connect = async () => {
    const error = new Error("timeout exceeded when trying to connect");
    throw error;
  };

  const telemetry = createDatabasePoolTelemetry({
    pool,
    role: "http",
    instance: "0",
    nowMs: () => 60_000,
    monotonicNowNs: (() => {
      let value = 0n;
      return () => (value += 2_000_000n);
    })(),
  });
  await assert.rejects(pool.connect(), /timeout exceeded/);
  let snapshot = telemetry.captureForTest(60_000);
  assert.equal(snapshot.buckets[0].interval.queuedCheckouts, 1);
  assert.equal(snapshot.buckets[0].interval.queuedTimeouts, 1);
  assert.equal(snapshot.buckets[0].interval.physicalAttempts, 0);

  pool.totalCount = 4;
  pool.connect = telemetry.wrapConnectForTest(async () => {
    const error = new Error("connect ETIMEDOUT 10.0.0.1:5432");
    error.code = "ETIMEDOUT";
    throw error;
  });
  await assert.rejects(pool.connect(), /ETIMEDOUT/);
  snapshot = telemetry.captureForTest(120_000);
  assert.equal(snapshot.buckets.at(-1).interval.physicalAttempts, 1);
  assert.equal(snapshot.buckets.at(-1).interval.physicalTimeouts, 1);
  assert.equal(snapshot.buckets.at(-1).interval.physicalErrors, 0);
});

test("zero heartbeat is complete, bounded, and contains no forbidden request material", () => {
  const pool = new EventEmitter();
  pool.options = { max: 20 };
  pool.totalCount = 0;
  pool.idleCount = 0;
  pool.waitingCount = 0;
  pool.connect = async () => ({ release() {} });
  const telemetry = createDatabasePoolTelemetry({
    pool,
    role: "cron",
    instance: "0",
    nowMs: () => 60_000,
  });
  const snapshot = telemetry.captureForTest(60_000);
  assert.equal(snapshot.schema, "database-pool-telemetry-snapshot-v1");
  assert.equal(snapshot.coverageMinutes, 1);
  assert.deepEqual(snapshot.buckets[0].interval, {
    acquisitions: 0,
    releases: 0,
    queuedCheckouts: 0,
    queuedTimeouts: 0,
    physicalAttempts: 0,
    physicalTimeouts: 0,
    physicalErrors: 0,
  });
  assert.ok(Buffer.byteLength(JSON.stringify(snapshot)) <= 512 * 1024);
  assert.doesNotMatch(JSON.stringify(snapshot), /user(Id|name)|email|token|requestId|sql|databaseUrl/i);
});

test("step ingestion keeps only allowlisted endpoint/outcome aggregates", () => {
  const pool = new EventEmitter();
  Object.assign(pool, { options: { max: 20 }, totalCount: 0, idleCount: 0, waitingCount: 0 });
  pool.connect = async () => ({ release() {} });
  const telemetry = createDatabasePoolTelemetry({ pool, role: "http", instance: "1", nowMs: () => 60_000 });
  telemetry.recordStepRequest({ endpoint: "steps", outcome: "success", durationMs: 12, authenticationDurationMs: 2 });
  telemetry.recordStepRequest({ endpoint: "steps", outcome: "server_5xx", durationMs: 18, userId: "must-not-appear" });
  telemetry.recordStepRequest({ endpoint: "unknown", outcome: "raw-secret-error", durationMs: 1 });
  const aggregate = telemetry.captureForTest(60_000).buckets[0].stepIngestion;
  assert.equal(aggregate.requests, 2);
  assert.equal(aggregate.successes, 1);
  assert.equal(aggregate.failures, 1);
  assert.equal(aggregate.endpoints[0].endpoint, "steps");
  assert.doesNotMatch(JSON.stringify(aggregate), /must-not-appear|raw-secret-error/);
});

test("production timer is unref'd and graceful stop clears it without emitting", () => {
  const pool = new EventEmitter();
  Object.assign(pool, { options: { max: 20 }, totalCount: 0, idleCount: 0, waitingCount: 0 });
  pool.connect = async () => ({ release() {} });
  const calls = [];
  const timer = { unref() { calls.push("unref"); } };
  const telemetry = createDatabasePoolTelemetry({
    pool,
    role: "cron",
    instance: "0",
    nowMs: () => 1,
    setTimer() { calls.push("set"); return timer; },
    clearTimer(value) { assert.equal(value, timer); calls.push("clear"); },
  });
  const handle = telemetry.start();
  handle.stop();
  assert.deepEqual(calls, ["set", "unref", "clear"]);
});

test("pressure warnings emit immediately and then rate-limit independently by reason", async () => {
  const pool = new EventEmitter();
  Object.assign(pool, { options: { max: 20 }, totalCount: 20, idleCount: 0, waitingCount: 1 });
  pool.connect = async () => { throw new Error("timeout exceeded when trying to connect"); };
  let clock = 1;
  const lines = [];
  const telemetry = createDatabasePoolTelemetry({
    pool,
    role: "http",
    instance: "0",
    nowMs: () => clock,
    logger: { log(line) { lines.push(JSON.parse(line)); } },
  });
  await assert.rejects(pool.connect());
  await assert.rejects(pool.connect());
  assert.deepEqual(lines.map((line) => line.reason), ["waiting_nonzero", "queued_checkout_timeout"]);
  clock += 60_000;
  await assert.rejects(pool.connect());
  assert.deepEqual(lines.map((line) => line.reason), [
    "waiting_nonzero", "queued_checkout_timeout", "waiting_nonzero", "queued_checkout_timeout",
  ]);
});

test("physical non-timeout errors and exact acquire/release events remain distinct", async () => {
  const pool = new EventEmitter();
  Object.assign(pool, { options: { max: 20 }, totalCount: 1, idleCount: 0, waitingCount: 0 });
  pool.connect = async () => { throw new Error("certificate rejected"); };
  const telemetry = createDatabasePoolTelemetry({ pool, role: "cron", instance: "0", nowMs: () => 60_000 });
  pool.emit("acquire");
  pool.emit("acquire");
  pool.emit("release");
  await assert.rejects(pool.connect(), /certificate rejected/);
  const snapshot = telemetry.captureForTest(60_000);
  assert.equal(snapshot.pool.checkedOut, 1);
  assert.equal(snapshot.buckets[0].interval.acquisitions, 2);
  assert.equal(snapshot.buckets[0].interval.releases, 1);
  assert.equal(snapshot.buckets[0].interval.physicalAttempts, 1);
  assert.equal(snapshot.buckets[0].interval.physicalTimeouts, 0);
  assert.equal(snapshot.buckets[0].interval.physicalErrors, 1);
});

test("minute rollup retains at most 60 distinct buckets", () => {
  const pool = new EventEmitter();
  Object.assign(pool, { options: { max: 20 }, totalCount: 0, idleCount: 0, waitingCount: 0 });
  pool.connect = async () => ({ release() {} });
  const telemetry = createDatabasePoolTelemetry({ pool, role: "cron", instance: "0", nowMs: () => 0 });
  let snapshot;
  for (let minute = 1; minute <= 61; minute += 1) {
    snapshot = telemetry.captureForTest(minute * 60_000);
  }
  assert.equal(snapshot.coverageMinutes, 60);
  assert.equal(snapshot.buckets.length, 60);
  assert.equal(new Set(snapshot.buckets.map((bucket) => bucket.minuteStartedAtMs)).size, 60);
});

test("representative populated HTTP telemetry retains all 60 buckets with 20% snapshot headroom", async () => {
  const pool = new EventEmitter();
  Object.assign(pool, { options: { max: 20 }, totalCount: 0, idleCount: 0, waitingCount: 0 });
  pool.connect = async () => ({ release() {} });
  let clock = 0;
  let monotonic = 0n;
  const telemetry = createDatabasePoolTelemetry({
    pool,
    role: "http",
    instance: "0",
    nowMs: () => clock,
    monotonicNowNs: () => (monotonic += 1_000_000n),
    logger: { log() {} },
  });
  let snapshot;
  for (let minute = 1; minute <= 60; minute += 1) {
    clock = minute * 60_000;
    pool.totalCount = 20;
    await pool.connect();
    pool.totalCount = 1;
    await pool.connect();
    pool.emit("acquire");
    pool.emit("release");
    for (const endpoint of ENDPOINTS) {
      for (const outcome of OUTCOMES) {
        telemetry.recordStepRequest({
          endpoint,
          outcome,
          durationMs: 100,
          authenticationDurationMs: 10,
          checkoutWaitDurationsMs: [5],
          transactionDurationsMs: [50],
        });
      }
    }
    for (const phase of PHASES) {
      telemetry.recordStepPhase({ phase, durationMs: 25, samplingRate: 1 });
    }
    snapshot = telemetry.captureForTest(clock);
  }
  assert.equal(snapshot.coverageMinutes, 60);
  assert.equal(snapshot.buckets.length, 60);
  assert.equal(snapshot.buckets[0].stepIngestion.phases.length, PHASES.size);
  assert.ok(snapshot.buckets[0].queuedWaitHistogram.observations > 0);
  assert.ok(snapshot.buckets[0].physicalConnectionDurationHistogram.observations > 0);
  assert.equal(snapshot.oldestBucketAt, snapshot.buckets[0].minuteStartedAt);
  assert.ok(Buffer.byteLength(JSON.stringify(snapshot)) <= 419_430);
});
