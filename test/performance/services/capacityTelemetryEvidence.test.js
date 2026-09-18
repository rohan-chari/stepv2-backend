const assert = require("node:assert/strict");
const test = require("node:test");

const {
  extractCapacityTelemetryEvidence,
} = require("../../src/shared/observability/capacityTelemetryEvidence");
const {
  LOG_MESSAGE,
  runCapacityMetricsEntry,
  startCapacityPhase,
} = require("../../src/shared/observability/capacityPhaseMetrics");

test("capacity telemetry evidence extracts one claimable server-derived run cohort", () => {
  const base = {
    event: "capacity_phase_metrics_v1",
    queryCaptureAvailable: true,
    measurementGateEligible: true,
    queryCaptureSetting: "PRISMA_QUERY_EVENTS_ENABLED=true",
    dimensions: { runId: "pool3-baseline-r2", repeat: "2" },
  };
  const evidence = extractCapacityTelemetryEvidence([
    { ...base, surface: "progress_projection_hydration" },
    { ...base, surface: "message_access" },
  ], { runId: "pool3-baseline-r2", repeat: "2" });

  assert.deepEqual(evidence, {
    schema: "capacity-telemetry-server-evidence-v1",
    runId: "pool3-baseline-r2",
    repeat: "2",
    event: "capacity_phase_metrics_v1",
    sampleCount: 2,
    queryCaptureAvailable: true,
    measurementGateEligible: true,
    queryCaptureSetting: "PRISMA_QUERY_EVENTS_ENABLED=true",
    surfaces: ["message_access", "progress_projection_hydration"],
  });
});

test("capacity telemetry evidence rejects unavailable, mismatched, or empty cohorts", () => {
  const metric = {
    event: "capacity_phase_metrics_v1",
    surface: "message_access",
    queryCaptureAvailable: false,
    measurementGateEligible: false,
    queryCaptureSetting: "PRISMA_QUERY_EVENTS_ENABLED!=true",
    dimensions: { runId: "run-r1", repeat: "1" },
  };
  assert.throws(
    () => extractCapacityTelemetryEvidence([metric], { runId: "run-r1", repeat: "1" }),
    /query capture unavailable/,
  );
  assert.throws(
    () => extractCapacityTelemetryEvidence([metric], { runId: "other", repeat: "1" }),
    /no capacity telemetry samples/,
  );
  assert.throws(
    () => extractCapacityTelemetryEvidence([], { runId: "run-r1", repeat: "1" }),
    /no capacity telemetry samples/,
  );
});

test("capacity production console transport emits one NDJSON record directly consumable by the extractor", async () => {
  const calls = [];
  const originalLog = console.log;
  console.log = (...args) => { calls.push(args); };
  try {
    await runCapacityMetricsEntry(
      {
        settings: { async getFlag() { return true; } },
        logger: console,
        env: { CAPACITY_PHASE_METRICS_SAMPLE_RATE: "1" },
        random: () => 0,
        queryCaptureAvailable: true,
        entryDimensions: { runId: "console-smoke-r1", repeat: "1" },
      },
      async () => {
        const span = startCapacityPhase("console_transport");
        await span.measurePhase("work", async () => {});
        span.finish();
      },
    );
  } finally {
    console.log = originalLog;
  }

  assert.equal(calls.length, 1);
  assert.equal(calls[0].length, 1, "console transport must receive one argument");
  assert.equal(typeof calls[0][0], "string");
  assert.equal(calls[0][0].includes("\n"), false);
  const record = JSON.parse(calls[0][0]);
  assert.equal(record.message, LOG_MESSAGE);
  assert.equal(record.event, "capacity_phase_metrics_v1");
  assert.equal(record.dimensions.runId, "console-smoke-r1");

  const evidence = extractCapacityTelemetryEvidence([record], {
    runId: "console-smoke-r1",
    repeat: "1",
  });
  assert.equal(evidence.sampleCount, 1);
  assert.deepEqual(evidence.surfaces, ["console_transport"]);
});
