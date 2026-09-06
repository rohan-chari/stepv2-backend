const test = require("node:test");
const assert = require("node:assert/strict");

const {
  deltaPgStatStatements,
  classifyPrimaryBottleneck,
  classifyFailureReason,
  buildSummary,
  phaseRuntime,
  snapshotPgStatStatements,
  outcomeAccounting, cpuDeltaPercent, validateSamplerCoverage, validateLoadShape, logicalFixtureHash, reconcileCaptureWork,
} = require("../../../src/modules/loadTesting/globalEventSyncAnalysis");

test("outcome accounting covers every iteration without double counting", () => {
  const result = outcomeAccounting({ status: { 202: { values: { count: 3 } }, 409: { values: { count: 1 } }, 429: { values: { count: 1 } }, 400: { values: { count: 2 } }, 500: { values: { count: 2 } } }, networkFailure: 1, clientTimeout: 1, malformedResponse: 1 }, 12);
  assert.deepEqual(result, { accepted202: 3, conflict409: 1, cooldown429: 1, other4xx: 2, server5xx: 2, networkFailure: 1, clientTimeout: 1, malformedResponse: 1, unexpectedStatus: 0, total: 12, iterations: 12, complete: true });
});

test("CPU delta uses elapsed wall time and explicit normalization", () => {
  assert.equal(cpuDeltaPercent({ user: 0, system: 0 }, { user: 2_000_000, system: 0 }, 2), 100);
  assert.equal(cpuDeltaPercent({ user: 0, system: 0 }, { user: 2_000_000, system: 0 }, 2, { hostCores: 4, mode: "host-normalized" }), 25);
});

test("sampler coverage requires measured samples", () => {
  const result = validateSamplerCoverage([{ phase: "warmup" }, ...Array.from({ length: 7 }, () => ({ phase: "measured" })), { phase: "drain" }], { measuredDurationSeconds: 8 });
  assert.equal(result.valid, true);
  assert.equal(result.measuredSamples, 7);
});

test("load shape enforces exact one-shot volume and duration tolerance", () => {
  assert.equal(validateLoadShape({ requestedRate: 5, requestedDurationSeconds: 8, iterations: 40, actualDurationSeconds: 8, uniqueUsers: 40 }).valid, true);
  assert.equal(validateLoadShape({ requestedRate: 5, requestedDurationSeconds: 8, iterations: 39, actualDurationSeconds: 8, uniqueUsers: 40 }).valid, false);
});

test("logical fixture hash ignores physical identity but changes topology", () => {
  const a = logicalFixtureHash({ seed: "s", runId: "one", userId: "uuid-a", createdAt: "now", users: 10, overlap: 0.5 });
  const b = logicalFixtureHash({ seed: "s", runId: "two", userId: "uuid-b", createdAt: "later", users: 10, overlap: 0.5 });
  assert.equal(a, b);
  assert.notEqual(a, logicalFixtureHash({ seed: "s", users: 10, overlap: 0.8 }));
});

test("capture reconciliation distinguishes explained and stuck work", () => {
  const valid = reconcileCaptureWork({ scheduledUsers: ["u1", "u2"], attemptedUsers: ["u1"], acceptedUsers: ["u1"], failedUsers: [], post: { WAITING_SYNC: 1, completedUsers: 1 }, expectedArtifacts: 1, artifacts: [{ id: "a" }] });
  assert.equal(valid.valid, true);
  const stuck = reconcileCaptureWork({ scheduledUsers: ["u1"], attemptedUsers: ["u1"], acceptedUsers: ["u1"], post: { WAITING_SYNC: 0, completedUsers: 0 }, expectedArtifacts: 1, artifacts: [] });
  assert.equal(stuck.valid, false);
});

test("pg_stat_statements deltas calculate rates and measured-time share", () => {
  const rows = deltaPgStatStatements([
    { queryid: "1", calls: 10, total_exec_time: 100, rows: 50, shared_blks_hit: 20 },
    { queryid: "1", calls: 15, total_exec_time: 250, rows: 80, shared_blks_hit: 40 },
    { queryid: "2", calls: 2, total_exec_time: 50, rows: 4 },
  ], { durationSeconds: 5 });
  assert.equal(rows[0].queryid, "1");
  assert.equal(rows[0].calls, 5);
  assert.equal(rows[0].callsPerSecond, 1);
  assert.equal(rows[0].totalExecutionTimeMs, 150);
  assert.equal(rows[0].rows, 30);
  assert.equal(rows[0].percentageOfMeasuredDbTime, 75);
});

test("failure reason and primary bottleneck are independent", () => {
  const metrics = { gates: { homeP95: false }, db: { cpuPercent: 94 }, node: { cpuPercent: 50 } };
  assert.equal(classifyFailureReason(metrics), "home_p95_threshold");
  assert.equal(classifyPrimaryBottleneck(metrics), "postgres");
  assert.equal(classifyFailureReason({ gates: { lockWait: false }, db: { cpuPercent: 40 } }), "lock_wait_threshold");
  assert.equal(classifyPrimaryBottleneck({ gates: { lockWait: false }, db: { cpuPercent: 40 }, pool: { waiting: 8 } }), "db_pool");
});

test("runtime accounting reports every scan phase", () => {
  const phases = phaseRuntime({ environmentPreparation: 1000, measuredLoad: 3000 }, 500);
  assert.equal(phases.totalMs, 4000);
  assert.equal(phases.measuredLoadMs, 3000);
  assert.equal(phases.reportGenerationMs, 0);
});

test("summary schema carries failure reason and bottleneck separately", () => {
  const summary = buildSummary({ profile: "eligible-overlap", runId: "sync-run-1", highestPassingRate: 10,
    firstFailingRate: 15, failureReason: "db_cpu_threshold", primaryBottleneck: "postgres",
    safeCapacity: { testedRate: 8, status: "measured" }, runtime: { totalMs: 1234 } });
  assert.equal(summary.schema, "global-event-step-sync-summary-v1");
  assert.equal(summary.failureReason, "db_cpu_threshold");
  assert.equal(summary.primaryBottleneck, "postgres");
  assert.equal(summary.safeCapacity.status, "measured");
});

test("pg_stat_statements absence is explicit and never treated as zero evidence", async () => {
  const unavailable = await snapshotPgStatStatements({ query: async () => { const error = new Error("missing"); error.code = "42P01"; throw error; } });
  assert.equal(unavailable.status, "unavailable");
  assert.equal(unavailable.reason, "pg_stat_statements_absent");
});
