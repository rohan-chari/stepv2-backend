const assert = require("node:assert/strict");
const test = require("node:test");

const { classifyAttempt, runScan } = require("../../../performance/lib/evaluate");
const { buildSummary, renderReport } = require("../../../performance/lib/report");

function config(overrides = {}) {
  return {
    workload: { name: "authenticated-races-tab-reveal-v1", profileVersion: "1.0.0" },
    cache: { raceListTargetMix: "calibration-required" },
    thresholds: {
      racesCoreP95Ms: 1000, racesCoreP99Ms: 2000, httpErrorRate: 0.001,
      networkErrors: 0, incompleteRacesCoreTransactions: 0,
      incompleteRacesDiscovery: 0, incompleteRacesFriends: 0,
      droppedArrivals: 0, workerRestarts: 0, databaseConnectionsExhausted: 0,
      queueGrowth: "baseline-required", resourceSafety: "baseline-required",
    },
    scan: { rates: [5], narrowingResolutionPerSecond: 1 },
    safeCapacity: { headroomFactor: 0.8, fallbackStepPerSecond: 1 },
    ...overrides,
  };
}

function evidence(overrides = {}) {
  return {
    racesCoreP95Ms: 500, racesCoreP99Ms: 900, httpErrorRate: 0,
    networkErrors: 0, incompleteRacesCoreTransactions: 0,
    incompleteRacesDiscovery: 0, incompleteRacesFriends: 0,
    racesContractErrors: 0, droppedArrivals: 0, workerRestarts: 0,
    databaseConnectionsExhausted: 0, targetIdentityValid: true,
    safeCapacityGatesPassed: false,
    racesTabOpen: { scheduler: { quotaDrift: 0, offeredQuotaDrift: 0,
      completionQuotaDrift: 0 },
      cacheSourceMix: { eventCount: 0 } },
    ...overrides,
  };
}

test("Races evaluator uses stable screen-specific failures independent of bottleneck", () => {
  assert.equal(classifyAttempt(evidence({ racesCoreP95Ms: 1001 }), config()).failureReason,
    "races_core_p95_threshold");
  assert.equal(classifyAttempt(evidence({ incompleteRacesDiscovery: 1 }), config()).failureReason,
    "incomplete_races_discovery");
  assert.equal(classifyAttempt(evidence({ incompleteRacesFriends: 1 }), config()).failureReason,
    "incomplete_races_friends");
  assert.equal(classifyAttempt(evidence({ racesContractErrors: 1 }), config()).failureReason,
    "races_contract_error");
  assert.equal(classifyAttempt(evidence({ racesTabOpen: { scheduler: { quotaDrift: -1 } } }), config()).failureReason,
    "scheduler_quota_drift");
});

test("uncalibrated cache evidence allows diagnostics but withholds safe capacity", async () => {
  const result = await runScan({ config: config(), executeRate: async () =>
    classifyAttempt(evidence(), config()) });
  assert.equal(result.highestPassingRate, 5);
  assert.equal(result.safeOperatingRate, null);
  assert.equal(result.safeOperatingRateUnit, "races_tab_opens_per_second");
  assert.equal(result.safeCapacityUnavailableReason, "safe_gate_baseline_required");
});

test("v3 summary and report retain Home compatibility and lead with Races-tab semantics", () => {
  const summary = buildSummary({ runId: "races-report", mode: "scan",
    workload: { name: "authenticated-races-tab-reveal-v1", profileVersion: "1.0.0" },
    fixtureProfile: { modeledStateProfile: { included: ["active-race-count", "zero-race",
      "zero-friends"], deferred: ["pending", "completed", "invited", "tournament",
      "team-race", "review-opportunity", "payout-double"] } },
    scan: { highestPassingRate: 20, firstFailingRate: 25,
      safeOperatingRate: 16, safeOperatingRateUnit: "races_tab_opens_per_second",
      safeHomeOpensPerSecond: null, failureReason: "races_core_p95_threshold",
      failureReasonDetail: { observed: 1480, threshold: 1000, unit: "ms" },
      primaryBottleneck: "postgres" },
    levels: [{ rate: 20, racesCoreP95Ms: 811, racesCoreP99Ms: 1400,
      httpErrorRate: 0, racesTabOpen: { discovery: { started: 1200, completed: 1200,
        errors: 0, latencyMs: { p95: 91, p99: 141 } },
        friends: { started: 360, completed: 360, errors: 0,
          latencyMs: { p95: 42, p99: 72 } },
        requestCountsByEndpoint: { "GET /races": 1200,
          "GET /races/discovery-summary": 1200, "GET /friends": 360 } } }],
  });
  assert.equal(summary.schema, "bara-perf-summary-v3");
  assert.equal(summary.safeOperatingRate, 16);
  assert.equal(summary.safeHomeOpensPerSecond, null);
  assert.equal(summary.levels[0].racesTabOpen.discovery.completed, 1200);
  const report = renderReport(summary);
  assert.match(report, /Bara Races Tab Capacity/);
  assert.match(report, /Races tab opens\/sec/);
  assert.match(report, /not total HTTP RPS/i);
  assert.match(report, /1,480 ms/);
  assert.match(report, /PostgreSQL/);
  assert.match(report, /GET \/friends/);
  assert.match(report, /1200\/1200\/0 \| 91\/141/);
  assert.match(report, /360\/360\/0 \| 42\/72/);
  assert.match(report, /Deferred states: pending, completed, invited, tournament, team-race, review-opportunity, payout-double/);
});

test("non-latency Races failures never fall back to Home units", () => {
  const summary = buildSummary({ runId: "races-error", mode: "scan",
    workload: { name: "authenticated-races-tab-reveal-v1", profileVersion: "1.0.0" },
    scan: { firstFailingRate: 5, failureReason: "races_contract_error",
      primaryBottleneck: "inconclusive" } });
  const report = renderReport(summary);
  assert.match(report, /5 Races tab opens\/sec failed/);
  assert.doesNotMatch(report, /5 Home opens\/sec failed/);
});
