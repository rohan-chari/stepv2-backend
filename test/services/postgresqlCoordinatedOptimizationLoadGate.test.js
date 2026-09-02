const assert = require("node:assert/strict");
const test = require("node:test");
const { evaluateLoadGate, RECOVERY_LIMITS_MS } = require("../../scripts/postgresql-coordinated-optimization-load-gate");

test("load gate enforces the complete production-shaped acceptance contract", () => {
  const statements = [
    { normalizedQuery: "race_resolution SKIP LOCKED", callsPerSecond: 100, shared_blks_hit: 0, rows: 0 },
    { normalizedQuery: "global_event_summary_work", callsPerSecond: 0, shared_blks_hit: 100, rows: 0 },
    { normalizedQuery: "domain_event_notification_projections", callsPerSecond: 0, shared_blks_hit: 0, rows: 100 },
  ];
  const baseline = { intervalSeconds: 60, statements, runtimeEvidence: {
    p95Ms: { resolution: 100, placement: 50, notification: 30 },
    healthyRedis: {
      commitToDrainRequestMs: { p50: 4, p95: 8, p99: 12 },
      commitToFirstClaimMs: { p50: 7, p95: 14, p99: 20 },
    },
  } };
  const candidate = { intervalSeconds: 60, statements: statements.map((row) => ({ ...row,
    callsPerSecond: row.callsPerSecond / 10, shared_blks_hit: row.shared_blks_hit / 10,
    rows: row.rows / 10 })), runtimeEvidence: {
    scoring: { participants: 500, fallbackCount: 0, maxPageHeapGrowthBytes: 32 * 1024 * 1024,
      retainedHeapSlopeBytesPerPage: 0 },
    p95Ms: { resolution: 100, placement: 50, notification: 30 },
    healthyRedis: {
      measurementResolutionMs: 10,
      commitToDrainRequestMs: { p50: 10, p95: 18, p99: 22 },
      commitToFirstClaimMs: { p50: 12, p95: 24, p99: 30 },
    },
    eligibleWorkWaitingForRecoveryPoll: 0,
    lostWakeRecoveryMs: { ...RECOVERY_LIMITS_MS },
    postTaskEmptyClaimsPer30Seconds: 1,
    waitingRacesRecoveryChurn: 0,
    duplicateVisibleOutputs: 0,
  } };
  assert.deepEqual(evaluateLoadGate(baseline, candidate).failures, []);
  candidate.runtimeEvidence.scoring.fallbackCount = 1;
  assert.match(evaluateLoadGate(baseline, candidate).failures.map((row) => row.name).join(), /NoFallback/);
});

test("load gate fails closed when any runtime metric is absent", () => {
  const result = evaluateLoadGate({ statements: [], runtimeEvidence: {} }, {
    statements: [], runtimeEvidence: {},
  });
  assert.ok(result.failures.length > 0);
  assert.match(result.failures.map((row) => row.name).join(","), /p95NoRegression/);
});
