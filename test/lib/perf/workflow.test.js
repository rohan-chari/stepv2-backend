const assert = require("node:assert/strict");
const path = require("node:path");
const test = require("node:test");

const { loadConfig } = require("../../../performance/lib/config");
const { runPerformanceWorkflow } = require("../../../performance/lib/workflow");

const repository = path.resolve(__dirname, "../../..");

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
  const result = await runPerformanceWorkflow({ repository, cli: { command: "scan",
    target: "lima", background: "normal", cache: "warm", keepRunning: false }, config,
  provider: {
    prepare: async () => { interrupted = true; return { datasetId: "test", binding: {} }; },
    validate: async () => { validated = true; },
    cleanup: async () => {},
  }, workload: {}, writeResult: false,
  getInterruption: () => interrupted ? "SIGINT" : null });
  assert.equal(validated, false);
  assert.equal(result.failed, true);
  assert.equal(result.summary.status, "failed");
  assert.equal(result.summary.error.stage, "interruption");
  assert.match(result.summary.error.message, /SIGINT/);
});
