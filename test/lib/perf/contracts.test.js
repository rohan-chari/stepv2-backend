const assert = require("node:assert/strict");
const path = require("node:path");
const test = require("node:test");

const repository = path.resolve(__dirname, "../../..");

test("Bara perf contracts are versioned and stable", () => {
  const {
    BOTTLENECKS,
    FAILURE_REASONS,
    RATE_STATES,
    SUMMARY_SCHEMA,
  } = require("../../../performance/lib/contracts");

  assert.equal(SUMMARY_SCHEMA, "bara-perf-summary-v2");
  assert.deepEqual([...RATE_STATES], ["PASS", "FAIL", "UNSTABLE"]);
  assert.deepEqual([...FAILURE_REASONS], [
    "home_p95_threshold",
    "home_p99_threshold",
    "http_error_rate",
    "network_errors",
    "incomplete_home_transactions",
    "dropped_arrivals",
    "worker_restart",
    "db_connection_exhaustion",
    "queue_growth",
    "resource_safety_threshold",
    "timeout",
    "multiple",
    "unknown",
  ]);
  assert.deepEqual([...BOTTLENECKS], [
    "postgres", "node", "db_pool", "redis", "queue", "generator",
    "multiple", "inconclusive",
  ]);
});

test("central config layers mode policy without changing locked defaults", () => {
  const { loadConfig } = require("../../../performance/lib/config");

  const smoke = loadConfig({ repository, mode: "smoke" });
  assert.equal(smoke.workload.name, "authenticated-home-reveal-v1");
  assert.equal(smoke.smoke.rate, 5);
  assert.equal(smoke.smoke.warmupSeconds, 30);
  assert.equal(smoke.smoke.measurementSeconds, 120);

  const scan = loadConfig({ repository, mode: "scan" });
  assert.deepEqual(scan.scan.rates, [5, 10, 15, 20, 25, 30]);
  assert.equal(scan.scan.warmupSeconds, 15);
  assert.equal(scan.scan.maxNormalWarmupSeconds, 30);
  assert.equal(scan.scan.measurementSeconds, 60);
  assert.equal(scan.scan.confirmBoundaryFailure, true);
  assert.equal(scan.scan.maxAttemptsAtBoundaryRate, 3);
  assert.equal(scan.scan.classificationPolicy, "majority");
  assert.equal(scan.scan.preparedRuntimeTargetSeconds, 900);
  assert.equal(scan.scan.runtimeWarningSeconds, 1200);
  assert.equal(scan.safeCapacity.headroomFactor, 0.8);
  assert.equal(scan.safeCapacity.rounding, "ceiling");
  assert.equal(scan.safeCapacity.fallbackStepPerSecond, 1);
  assert.equal(scan.safeCapacity.requireMeasuredPass, true);
  assert.equal(scan.runtime.perLevelCeremonyTargetSeconds, 15);

  const certify = loadConfig({ repository, mode: "certify" });
  assert.equal(certify.certify.warmupSeconds, 60);
  assert.equal(certify.certify.repeats, 3);
});

test("invalid overrides fail before any operation", () => {
  const { loadConfig } = require("../../../performance/lib/config");

  assert.throws(() => loadConfig({ repository, mode: "scan", overrides: {
    scan: { warmupSeconds: 31 },
  } }), /warmup/i);
  assert.throws(() => loadConfig({ repository, mode: "scan", overrides: {
    scan: { maxAttemptsAtBoundaryRate: 4 },
  } }), /attempt/i);
  assert.throws(() => loadConfig({ repository, mode: "scan", overrides: {
    safeCapacity: { rounding: "floor" },
  } }), /rounding/i);
});

test("CLI accepts only the documented safe grammar", () => {
  const { parseCli } = require("../../../performance/lib/cli");

  assert.deepEqual(parseCli(["scan"]), {
    command: "scan", target: "lima", background: "normal", cache: "warm",
    rates: null, keepRunning: false,
  });
  assert.deepEqual(parseCli(["smoke", "--cache=cold", "--background=off"]), {
    command: "smoke", target: "lima", background: "off", cache: "cold",
    rates: null, keepRunning: false,
  });
  assert.equal(parseCli(["scan", "--rates=5,10,25"]).rates.join(","), "5,10,25");
  assert.throws(() => parseCli(["scan", "--target=prod"]), /target/i);
  assert.throws(() => parseCli(["scan", "--base-url=https:\/\/steptracker-api.org"]), /unknown|option/i);
  assert.throws(() => parseCli(["wat"]), /usage/i);
});
