const assert = require("node:assert/strict");
const path = require("node:path");
const test = require("node:test");

const { loadConfig } = require("../../../performance/lib/config");
const { effectiveMeasurementSeconds, runPerformanceWorkflow } = require(
  "../../../performance/lib/workflow");

const repository = path.resolve(__dirname, "../../..");

test("Races v2 attempts extend only enough to measure 300 sessions", () => {
  const config = loadConfig({ repository, mode: "scan", workload: "races-tab-open" });
  assert.equal(effectiveMeasurementSeconds(config, 2, "discovery"), 150);
  assert.equal(effectiveMeasurementSeconds(config, 5, "discovery"), 60);
  assert.equal(effectiveMeasurementSeconds(config, 30, "discovery"), 60);
  const home = loadConfig({ repository, mode: "scan" });
  assert.equal(effectiveMeasurementSeconds(home, 2, "discovery"), 60);
});

test("scan prepares and validates once, prewarms once, and reuses one environment", async () => {
  const config = loadConfig({ repository, mode: "scan", overrides: {
    scan: { rates: [5, 10], narrowingResolutionPerSecond: 5, warmupSeconds: 0,
      measurementSeconds: 1 },
    cache: { initialPrewarmSeconds: 0 },
    thresholds: { queueGrowth: 1, resourceSafety: 1 },
  } });
  const log = [];
  const outcomes = new Map([[5, ["PASS"]], [10, ["FAIL", "FAIL"]], [4, ["PASS"]]]);
  const provider = {
    prepare: async () => (log.push("prepare"), { binding: "same-binding", prepared: true }),
    validate: async () => log.push("validate"),
    settle: async () => log.push("settle"),
    liveness: async () => log.push("liveness"),
    resetMetrics: async () => log.push("resetMetrics"),
    collectMetrics: async () => (log.push("collectMetrics"), {}),
    clearOwnedCache: async () => log.push("clearOwnedCache"),
    verifyOwnedCacheEmpty: async () => log.push("verifyOwnedCacheEmpty"),
    cleanup: async () => log.push("cleanup"),
  };
  const workload = {
    prepareFixtures: async () => (log.push("prepareFixtures"), { id: "fixtures" }),
    initialPrewarm: async () => log.push("initialPrewarm"),
    targetedReset: async () => log.push("targetedReset"),
    warmup: async () => log.push("warmup"),
    verifyFixtures: async () => log.push("verifyFixtures"),
    measure: async ({ rate, purpose }) => {
      log.push(`measure:${rate}:${purpose}`);
      const outcome = outcomes.get(rate)?.shift();
      return { rate, binding: "same-binding", homeP95Ms: outcome === "PASS" ? 500 : 1500,
        homeP99Ms: 1900, httpErrorRate: 0, networkErrors: 0,
        incompleteHomeTransactions: 0, droppedArrivals: 0, workerRestarts: 0,
        databaseConnectionsExhausted: 0, targetIdentityValid: true, queueGrowth: 0, resourceSafety: 0.5,
        timedOut: false, safeCapacityGatesPassed: true,
        resources: {} };
    },
  };
  const result = await runPerformanceWorkflow({
    repository, cli: { command: "scan", target: "lima", background: "normal",
      cache: "warm", rates: null, keepRunning: false }, config, provider, workload,
    writeResult: false,
  });
  assert.equal(log.filter((row) => row === "prepare").length, 1);
  assert.equal(log.filter((row) => row === "validate").length, 1);
  assert.equal(log.filter((row) => row === "prepareFixtures").length, 1);
  assert.equal(log.filter((row) => row === "initialPrewarm").length, 1);
  assert.equal(log.includes("restore"), false);
  assert.equal(log.includes("recreateDatabase"), false);
  assert.equal(log.filter((row) => row === "verifyFixtures").length, 1);
  assert.equal(result.summary.highestPassingRate, 5);
  assert.equal(result.summary.firstFailingRate, 10);
  assert.equal(result.summary.safeHomeOpensPerSecond, 4);
  assert.equal(log.at(-1), "cleanup");
});

test("fixture provisioning is included in reported end-to-end runtime", async () => {
  const config = loadConfig({ repository, mode: "smoke", overrides: {
    smoke: { warmupSeconds: 0, measurementSeconds: 1 }, cache: { initialPrewarmSeconds: 0 },
  } });
  let tick = 0;
  const now = () => (tick += 1000);
  const provider = { prepare: async () => ({ datasetId: "test", binding: {} }),
    validate: async () => {}, settle: async () => {}, liveness: async () => {},
    resetMetrics: async () => {}, collectMetrics: async () => ({}), cleanup: async () => {} };
  const workload = { prepareFixtures: async () => ({}), initialPrewarm: async () => {},
    targetedReset: async () => {}, warmup: async () => {}, cleanup: async () => {},
    measure: async () => ({ homeP95Ms: 1, homeP99Ms: 1, httpErrorRate: 0,
      networkErrors: 0, incompleteHomeTransactions: 0, droppedArrivals: 0,
      workerRestarts: 0, databaseConnectionsExhausted: 0, targetIdentityValid: true,
      safeCapacityGatesPassed: false }) };
  const result = await runPerformanceWorkflow({ repository, cli: { command: "smoke",
    target: "lima", background: "normal", cache: "warm", keepRunning: false }, config,
  provider, workload, writeResult: false, now });
  assert.ok(result.summary.scanRuntimeSeconds >= 8, "all workflow wall time must be visible");
});

test("a failed final fixture-stability check withholds an already measured safe rate", async () => {
  const config = loadConfig({ repository, mode: "scan", overrides: {
    scan: { rates: [1, 2], narrowingResolutionPerSecond: 1, warmupSeconds: 0,
      measurementSeconds: 1 },
    cache: { initialPrewarmSeconds: 0 },
    thresholds: { queueGrowth: 1, resourceSafety: 1 },
  } });
  const provider = {
    prepare: async () => ({ datasetId: "test", binding: {} }), validate: async () => {},
    settle: async () => {}, liveness: async () => {}, resetMetrics: async () => {},
    collectMetrics: async () => ({}), cleanup: async () => {},
  };
  let rateTwoAttempts = 0;
  const workload = {
    prepareFixtures: async () => ({}), initialPrewarm: async () => {},
    targetedReset: async () => {}, warmup: async () => {}, cleanup: async () => {},
    verifyFixtures: async () => { throw new Error("fixture distribution drifted"); },
    measure: async ({ rate }) => {
      if (rate === 2) rateTwoAttempts += 1;
      return { homeP95Ms: rate === 2 ? 1500 : 100, homeP99Ms: 200,
        httpErrorRate: 0, networkErrors: 0, incompleteHomeTransactions: 0,
        droppedArrivals: 0, workerRestarts: 0, databaseConnectionsExhausted: 0,
        targetIdentityValid: true, queueGrowth: 0, resourceSafety: 0,
        safeCapacityGatesPassed: true, resources: {} };
    },
  };
  const result = await runPerformanceWorkflow({ repository, cli: { command: "scan",
    target: "lima", background: "normal", cache: "warm", keepRunning: false }, config,
  provider, workload, writeResult: false });
  assert.equal(rateTwoAttempts, 2);
  assert.equal(result.failed, true);
  assert.equal(result.summary.safeOperatingRate, null);
  assert.equal(result.summary.safeHomeOpensPerSecond, null);
  assert.equal(result.summary.safeCapacityUnavailableReason, "workflow_failed");
});

test("setup failure still emits a partial result", async () => {
  const config = loadConfig({ repository, mode: "scan" });
  const result = await runPerformanceWorkflow({ repository, cli: { command: "scan",
    target: "lima", background: "normal", cache: "warm", keepRunning: false }, config,
  provider: { prepare: async () => { throw new Error("fixture target unavailable"); } },
  workload: {}, writeResult: false });
  assert.equal(result.failed, true);
  assert.equal(result.summary.status, "failed");
  assert.match(result.summary.error.message, /target unavailable/);
});

test("provider-lock/preflight failure still emits a partial result", async () => {
  const config = loadConfig({ repository, mode: "scan" });
  const result = await runPerformanceWorkflow({ repository, cli: { command: "scan",
    target: "lima", background: "normal", cache: "warm", keepRunning: false }, config,
  provider: { runExclusive: async () => { throw new Error("provider preflight unavailable"); } },
  workload: {}, writeResult: false });
  assert.equal(result.failed, true);
  assert.match(result.summary.error.message, /provider preflight unavailable/);
});

test("operator interruption emits a partial failed result before another phase starts", async () => {
  const config = loadConfig({ repository, mode: "scan" });
  let interrupted = false;
  let validated = false;
  let cleaned = false;
  const result = await runPerformanceWorkflow({ repository, cli: { command: "scan",
    target: "lima", background: "normal", cache: "warm", keepRunning: false }, config,
  provider: {
    prepare: async () => { interrupted = true; return { datasetId: "test", binding: {} }; },
    validate: async () => { validated = true; },
    cleanup: async () => { cleaned = true; },
  }, workload: {}, writeResult: false,
  getInterruption: () => interrupted ? "SIGINT" : null });
  assert.equal(validated, false);
  assert.equal(result.failed, true);
  assert.equal(result.summary.status, "failed");
  assert.equal(result.summary.error.stage, "interruption");
  assert.match(result.summary.error.message, /SIGINT/);
  assert.equal(cleaned, true);
});

test("a targeted-reset timeout still settles workload and provider cleanup", async () => {
  const config = loadConfig({ repository, mode: "smoke", overrides: {
    smoke: { warmupSeconds: 0, measurementSeconds: 1 }, cache: { initialPrewarmSeconds: 0 },
  } });
  const calls = [];
  const result = await runPerformanceWorkflow({ repository, cli: { command: "smoke",
    target: "lima", background: "normal", cache: "warm", keepRunning: false }, config,
  provider: {
    prepare: async () => ({ datasetId: "test", binding: {} }), validate: async () => {},
    settle: async () => {}, liveness: async () => {}, cleanup: async () => calls.push("provider"),
  }, workload: {
    prepareFixtures: async () => ({}), initialPrewarm: async () => {}, warmup: async () => {},
    targetedReset: async () => { const error = new Error("conditioning timeout");
      error.stage = "cache_conditioning"; throw error; },
    cleanup: async () => calls.push("workload"),
  }, writeResult: false });
  assert.equal(result.failed, true);
  assert.equal(result.summary.error.stage, "cache_conditioning");
  assert.deepEqual(calls, ["workload", "provider"]);
});

test("cleanup is settled so provider teardown runs and both failures are preserved", async () => {
  const config = loadConfig({ repository, mode: "scan" });
  const calls = [];
  const result = await runPerformanceWorkflow({ repository, cli: { command: "scan",
    target: "lima", background: "normal", cache: "warm", keepRunning: false }, config,
  provider: {
    prepare: async () => ({ datasetId: "test", binding: {} }),
    validate: async () => { throw new Error("validation failed"); },
    cleanup: async () => { calls.push("provider"); throw new Error("provider cleanup failed"); },
  }, workload: {
    cleanup: async () => { calls.push("workload"); throw new Error("workload cleanup failed"); },
  }, writeResult: false });
  assert.deepEqual(calls, ["workload", "provider"]);
  assert.equal(result.failed, true);
  assert.ok(result.error instanceof AggregateError);
  assert.deepEqual(result.error.errors.map((error) => error.message),
    ["validation failed", "workload cleanup failed", "provider cleanup failed"]);
});
