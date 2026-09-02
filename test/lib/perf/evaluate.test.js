const assert = require("node:assert/strict");
const test = require("node:test");

const { loadConfig } = require("../../../performance/lib/config");
const {
  classifyAttempt,
  classifyRate,
  inferPrimaryBottleneck,
  runScan,
} = require("../../../performance/lib/evaluate");

const loadedConfig = loadConfig({ repository: require("node:path").resolve(__dirname, "../../.."), mode: "scan" });
const config = { ...loadedConfig, thresholds: { ...loadedConfig.thresholds,
  queueGrowth: 1, resourceSafety: 0.9 } };

function evidence(overrides = {}) {
  return {
    rate: 10,
    binding: "binding-a",
    homeP95Ms: 500,
    homeP99Ms: 900,
    httpErrorRate: 0,
    networkErrors: 0,
    incompleteHomeTransactions: 0,
    droppedArrivals: 0,
    workerRestarts: 0,
    databaseConnectionsExhausted: 0,
    targetIdentityValid: true,
    queueGrowth: 0,
    resourceSafety: 0.5,
    timedOut: false,
    safeCapacityGatesPassed: true,
    resources: {},
    ...overrides,
  };
}

test("failure reason is stable and separate from inferred bottleneck", () => {
  const result = classifyAttempt(evidence({
    homeP95Ms: 1480,
    resources: { postgresCpuPercent: 94, nodeCpuPercent: 50, generatorSaturated: false,
      topSqlMaterial: true },
  }), config);
  assert.equal(result.outcome, "FAIL");
  assert.equal(result.failureReason, "home_p95_threshold");
  assert.deepEqual(result.failureReasonDetail, { observed: 1480, threshold: 1000, unit: "ms" });
  assert.equal(inferPrimaryBottleneck(result.evidence), "postgres");

  const multiple = classifyAttempt(evidence({ homeP95Ms: 1480, networkErrors: 2 }), config);
  assert.equal(multiple.failureReason, "multiple");
  assert.deepEqual(multiple.failedReasons.sort(), ["home_p95_threshold", "network_errors"]);
});

test("boundary voting confirms failure and resolves instability with at most three attempts", () => {
  assert.deepEqual(classifyRate([{ outcome: "PASS" }]), {
    state: "PASS", passes: 1, failures: 0, unstable: false, decided: true,
  });
  assert.deepEqual(classifyRate([{ outcome: "FAIL" }]), {
    state: "UNSTABLE", passes: 0, failures: 1, unstable: false, decided: false,
  });
  assert.deepEqual(classifyRate([{ outcome: "FAIL" }, { outcome: "FAIL" }]), {
    state: "FAIL", passes: 0, failures: 2, unstable: false, decided: true,
  });
  assert.deepEqual(classifyRate([{ outcome: "FAIL" }, { outcome: "PASS" }]), {
    state: "UNSTABLE", passes: 1, failures: 1, unstable: true, decided: false,
  });
  assert.deepEqual(classifyRate([{ outcome: "FAIL" }, { outcome: "PASS" }, { outcome: "PASS" }]), {
    state: "PASS", passes: 2, failures: 1, unstable: true, decided: true,
  });
});

test("scan confirms only boundary failures and does not repeat ordinary passing discovery levels", async () => {
  const outcomes = new Map([[5, ["PASS"]], [10, ["PASS"]], [15, ["FAIL", "FAIL"]],
    [12, ["PASS"]], [13, ["PASS"]], [14, ["FAIL", "FAIL"]],
    [11, ["PASS"]], [9, ["PASS"]]]);
  const calls = [];
  const result = await runScan({
    config: { ...config, scan: { ...config.scan, rates: [5, 10, 15] } },
    executeRate: async ({ rate, purpose }) => {
      calls.push({ rate, purpose });
      const outcome = outcomes.get(rate)?.shift();
      if (!outcome) throw new Error(`unexpected ${rate}`);
      return classifyAttempt(evidence({ rate, homeP95Ms: outcome === "PASS" ? 500 : 1500 }), config);
    },
  });

  assert.equal(result.highestPassingRate, 13);
  assert.equal(result.firstFailingRate, 14);
  assert.deepEqual(calls.filter((row) => row.rate === 5).map((row) => row.purpose), ["discovery"]);
  assert.deepEqual(calls.filter((row) => row.rate === 15).map((row) => row.purpose),
    ["discovery", "failure_confirmation"]);
  assert.deepEqual(calls.filter((row) => row.rate === 14).map((row) => row.purpose),
    ["boundary_narrowing", "failure_confirmation"]);
});

test("unstable failure candidate gets one deciding repetition", async () => {
  const outcomes = new Map([[5, ["PASS"]], [10, ["FAIL", "PASS", "FAIL"]], [4, ["PASS"]]]);
  const events = [];
  const result = await runScan({
    config: { ...config, scan: { ...config.scan, rates: [5, 10], narrowingResolutionPerSecond: 5 } },
    executeRate: async ({ rate, purpose }) => {
      events.push({ rate, purpose });
      const outcome = outcomes.get(rate)?.shift();
      return classifyAttempt(evidence({ rate, homeP95Ms: outcome === "PASS" ? 500 : 1500 }), config);
    },
  });
  const ten = result.rateClassifications.find((row) => row.rate === 10);
  assert.deepEqual([ten.state, ten.passes, ten.failures, ten.unstable], ["FAIL", 1, 2, true]);
  assert.equal(events.filter((row) => row.rate === 10).length, 3);
});

test("safe capacity is ceiling-rounded, measured, and deterministically steps down", async () => {
  const calls = [];
  const result = await runScan({
    config: { ...config, scan: { ...config.scan, rates: [10, 20, 24, 25], narrowingResolutionPerSecond: 1 } },
    executeRate: async ({ rate, purpose }) => {
      calls.push({ rate, purpose });
      const failedBoundary = rate === 25;
      const safeGateFailure = rate === 20;
      return classifyAttempt(evidence({ rate,
        homeP95Ms: failedBoundary ? 1500 : 500,
        safeCapacityGatesPassed: !safeGateFailure,
      }), config);
    },
  });

  assert.equal(result.highestPassingRate, 24);
  assert.equal(result.firstFailingRate, 25);
  assert.equal(result.calculatedHeadroomTarget, 19.2);
  assert.equal(result.safeCapacityCandidateTested, 20);
  assert.deepEqual(result.safeCapacityCandidates.map((row) => [row.rate, row.passedSafeCapacityGates]),
    [[20, false], [19, true]]);
  assert.equal(result.safeHomeOpensPerSecond, 19);
  assert.ok(calls.some((row) => row.rate === 20 && row.purpose === "safe_capacity"));
  assert.ok(calls.some((row) => row.rate === 19 && row.purpose === "safe_capacity"));
});

test("an existing same-binding candidate pass is reused but unmeasured capacity is never labeled safe", async () => {
  const calls = [];
  const result = await runScan({
    config: { ...config, scan: { ...config.scan, rates: [10, 20, 24, 25] } },
    executeRate: async ({ rate, purpose }) => {
      calls.push({ rate, purpose });
      return classifyAttempt(evidence({ rate, homeP95Ms: rate === 25 ? 1500 : 500 }), config);
    },
  });
  assert.equal(result.safeHomeOpensPerSecond, 20);
  assert.equal(calls.some((row) => row.rate === 20 && row.purpose === "safe_capacity"), false);
  assert.equal(result.safeCapacityCandidates[0].evidenceReused, true);
});

test("baseline-required queue/resource gates cannot produce safe operating capacity", async () => {
  const baselineConfig = { ...config, thresholds: { ...config.thresholds,
    queueGrowth: "baseline-required", resourceSafety: "baseline-required" } };
  const result = await runScan({
    config: { ...baselineConfig, scan: { ...baselineConfig.scan, rates: [5, 10] } },
    executeRate: async ({ rate }) => classifyAttempt(evidence({ rate,
      homeP95Ms: rate === 10 ? 1500 : 500 }), baselineConfig),
  });
  assert.equal(result.safeHomeOpensPerSecond, null);
  assert.equal(result.safeCapacityUnavailableReason, "safe_gate_baseline_required");
  assert.deepEqual(result.safeCapacityCandidates, []);
});
