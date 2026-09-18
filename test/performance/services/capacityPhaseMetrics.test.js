const assert = require("node:assert/strict");
const test = require("node:test");

const {
  KNOWN_FLAGS,
} = require("../../src/shared/config/appSettings");
const {
  LOG_MESSAGE,
  runCapacityMetricsEntry,
  startCapacityPhase,
} = require("../../src/shared/observability/capacityPhaseMetrics");
const {
  incrementRequestQueryCount,
} = require("../../src/shared/http/requestQueryCounter");

test("capacity phase metrics exact flag defaults off", () => {
  assert.equal(KNOWN_FLAGS.capacityPhaseMetricsV1Enabled, false);
});

test("capacity phase metrics stay inert while off and emit aggregate sampled fields while on", async () => {
  const logs = [];
  const logger = {
    log(message, fields) { logs.push({ message, fields }); },
  };

  await runCapacityMetricsEntry(
    {
      settings: { async getFlag() { return false; } },
      logger,
      env: { CAPACITY_PHASE_METRICS_SAMPLE_RATE: "1" },
    },
    async () => {
      const span = startCapacityPhase("off_surface");
      assert.equal(span.active, false);
      span.finish();
    },
  );
  assert.deepEqual(logs, []);

  await runCapacityMetricsEntry(
    {
      settings: { async getFlag(key) {
        assert.equal(key, "capacityPhaseMetricsV1Enabled");
        return true;
      } },
      logger,
      env: { CAPACITY_PHASE_METRICS_SAMPLE_RATE: "1" },
      random: () => 0,
      queryCaptureAvailable: true,
      readDbPoolPressure: () => ({ total: 3, idle: 2, waiting: 1 }),
    },
    async () => {
      const span = startCapacityPhase("unit_surface");
      await span.measurePhase("work", async () => {});
      span.setCounts({ items: 4, userId: 9, messageBodies: 2 });
      span.setDimensions({
        mode: "warm",
        token: "secret",
        sourceName: "sensitive",
        sourceOutcome: "changed",
        enabled: true,
      });
      span.finish("success");
    },
  );

  assert.equal(logs.length, 1);
  assert.equal(logs[0].message, LOG_MESSAGE);
  assert.equal(logs[0].fields.event, "capacity_phase_metrics_v1");
  assert.equal(logs[0].fields.surface, "unit_surface");
  assert.equal(logs[0].fields.sampled, true);
  assert.equal(logs[0].fields.queryCaptureAvailable, true);
  assert.equal(logs[0].fields.queryCaptureSetting, "PRISMA_QUERY_EVENTS_ENABLED=true");
  assert.equal(logs[0].fields.measurementGateEligible, true);
  assert.equal(logs[0].fields.queryCount, 0);
  assert.equal(typeof logs[0].fields.phaseMs.work, "number");
  assert.equal(logs[0].fields.phaseQueryCount.work, 0);
  assert.deepEqual(logs[0].fields.counts, { items: 4 });
  assert.deepEqual(logs[0].fields.dimensions, {
    mode: "warm",
    sourceOutcome: "changed",
    enabled: true,
  });
  assert.deepEqual(logs[0].fields.dbPoolPressure, {
    total: 3,
    idle: 2,
    waiting: 1,
  });
});

test("capacity phase metrics omit query fields and fail the measurement gate when capture is unavailable", async () => {
  const logs = [];
  await runCapacityMetricsEntry(
    {
      settings: { async getFlag() { return true; } },
      logger: { log(message, fields) { logs.push({ message, fields }); } },
      env: { CAPACITY_PHASE_METRICS_SAMPLE_RATE: "1" },
      random: () => 0,
      queryCaptureAvailable: false,
    },
    async () => {
      const span = startCapacityPhase("capture_unavailable");
      await span.measurePhase("database", async () => {
        incrementRequestQueryCount();
      });
      span.finish();
    },
  );

  assert.equal(logs.length, 1);
  const metric = logs[0].fields;
  assert.equal(metric.queryCaptureAvailable, false);
  assert.equal(metric.queryCaptureSetting, "PRISMA_QUERY_EVENTS_ENABLED!=true");
  assert.equal(metric.measurementGateEligible, false);
  assert.equal("queryCount" in metric, false);
  assert.equal("phaseQueryCount" in metric, false);
});

test("capacity phase metrics attribute concurrent queries exactly once to their async phase", async () => {
  const logs = [];
  let startA;
  let startB;
  const aStarted = new Promise((resolve) => { startA = resolve; });
  const bStarted = new Promise((resolve) => { startB = resolve; });

  await runCapacityMetricsEntry(
    {
      settings: { async getFlag() { return true; } },
      logger: { log(message, fields) { logs.push({ message, fields }); } },
      env: { CAPACITY_PHASE_METRICS_SAMPLE_RATE: "1" },
      random: () => 0,
      queryCaptureAvailable: true,
    },
    async () => {
      const span = startCapacityPhase("concurrent_fanout");
      await Promise.all([
        span.measurePhase("branchA", async () => {
          incrementRequestQueryCount();
          startA();
          await bStarted;
          incrementRequestQueryCount();
        }),
        span.measurePhase("branchB", async () => {
          incrementRequestQueryCount();
          startB();
          await aStarted;
          incrementRequestQueryCount();
        }),
      ]);
      span.finish();
    },
  );

  const metric = logs[0].fields;
  assert.deepEqual(metric.phaseQueryCount, { branchA: 2, branchB: 2 });
  assert.equal(metric.queryCount, 4);
});
