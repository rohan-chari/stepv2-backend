const assert = require("node:assert/strict");
const test = require("node:test");

const {
  assertPerformanceDatabase,
  assertSafeTrafficTarget,
  assertTargetIdentity,
  assertRefreshConnectionsSeparated,
} = require("../../../performance/lib/safety");

test("traffic safety rejects production, staging, redirects, and address drift", () => {
  assert.equal(assertSafeTrafficTarget({ baseUrl: "http://127.0.0.1:3000",
    resolvedAddresses: ["127.0.0.1"], target: "lima" }), true);
  for (const baseUrl of ["https://steptracker-api.org", "https://staging.steptracker-api.org",
    "http://167.172.225.16:3000"]) {
    assert.throws(() => assertSafeTrafficTarget({ baseUrl, resolvedAddresses: ["167.172.225.16"],
      target: "lima" }), /production|public|approved/i);
  }
  assert.throws(() => assertSafeTrafficTarget({ baseUrl: "http://localhost:3000",
    resolvedAddresses: ["127.0.0.1", "10.0.0.2"], target: "lima" }), /address|loopback/i);
  assert.throws(() => assertTargetIdentity({ expectedRunId: "perf-safe", expectedAddress: "127.0.0.1",
    response: { status: 302, address: "127.0.0.1", body: {} } }), /redirect/i);
  assert.throws(() => assertTargetIdentity({ expectedRunId: "perf-safe", expectedAddress: "127.0.0.1",
    response: { status: 200, address: "127.0.0.1", body: { capacityRunId: "other" } } }), /identity/i);
});

test("destructive database operations require both safe name and durable marker", () => {
  const safe = "postgresql://capacity@127.0.0.1:55433/steps_tracker_capacity";
  assert.equal(assertPerformanceDatabase({ databaseUrl: safe,
    marker: { owner: "bara-perf", disposable: true } }), true);
  assert.throws(() => assertPerformanceDatabase({ databaseUrl: safe, marker: null }), /marker/i);
  assert.throws(() => assertPerformanceDatabase({
    databaseUrl: "postgresql://capacity@db.prod/steps_tracker_capacity",
    marker: { owner: "bara-perf", disposable: true },
  }), /host|production/i);
  assert.throws(() => assertPerformanceDatabase({
    databaseUrl: "postgresql://capacity@127.0.0.1/app_production",
    marker: { owner: "bara-perf", disposable: true },
  }), /database/i);
});

test("refresh source is read-only and cannot be reused as writable target", () => {
  assert.equal(assertRefreshConnectionsSeparated({
    source: { url: "postgresql://reader@prod-db/app", transactionReadOnly: true },
    target: { url: "postgresql://capacity@127.0.0.1/steps_tracker_capacity",
      marker: { owner: "bara-perf", disposable: true } },
  }), true);
  assert.throws(() => assertRefreshConnectionsSeparated({
    source: { url: "postgresql://reader@prod-db/app", transactionReadOnly: false },
    target: { url: "postgresql://reader@prod-db/app", marker: { owner: "bara-perf", disposable: true } },
  }), /read.only|separate/i);
});
