const assert = require("node:assert/strict");
const test = require("node:test");

const {
  buildIntervalStatements,
} = require("../../scripts/postgresql-coordinated-optimization-metrics");

function row(overrides = {}) {
  return {
    queryid: "42", calls: 100, total_exec_time: 500, rows: 10,
    shared_blks_hit: 1000, shared_blks_read: 20, wal_bytes: "2000",
    query: "SELECT * FROM race_resolution_jobs_v2", ...overrides,
  };
}

test("collector derives calls/sec and resource use from two snapshots, not reset lifetime", () => {
  const baseline = {
    capturedAt: "2026-09-02T12:00:00.000Z",
    pgStatStatements: { statsResetAt: "2026-09-01T00:00:00.000Z", dealloc: 3 },
    statementSnapshot: [row()],
  };
  const result = buildIntervalStatements(
    baseline,
    [row({ calls: 140, total_exec_time: 620, rows: 18,
      shared_blks_hit: 1120, shared_blks_read: 24, wal_bytes: "2600" })],
    new Date("2026-09-02T12:00:10.000Z"),
    { statsResetAt: "2026-09-01T00:00:00.000Z", dealloc: 3 },
  );
  assert.equal(result.elapsedSeconds, 10);
  assert.equal(result.statements[0].calls, 40);
  assert.equal(result.statements[0].callsPerSecond, 4);
  assert.equal(result.statements[0].mean_exec_time, 3);
  assert.equal(result.statements[0].wal_bytes, "600");
});

test("collector fails closed when pg_stat_statements reset or deallocation invalidates deltas", () => {
  const baseline = {
    capturedAt: "2026-09-02T12:00:00.000Z",
    pgStatStatements: { statsResetAt: "2026-09-01T00:00:00.000Z", dealloc: 3 },
    statementSnapshot: [row()],
  };
  assert.throws(() => buildIntervalStatements(
    baseline, [row()], new Date("2026-09-02T12:00:10.000Z"),
    { statsResetAt: "2026-09-02T00:00:00.000Z", dealloc: 3 },
  ), /reset window changed/);
  assert.throws(() => buildIntervalStatements(
    baseline, [row()], new Date("2026-09-02T12:00:10.000Z"),
    { statsResetAt: "2026-09-01T00:00:00.000Z", dealloc: 4 },
  ), /deallocated/);
});
