const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const test = require("node:test");

const { buildSummary, renderReport, writeReports } = require("../../../performance/lib/report");

function input() {
  return {
    runId: "perf-20260902-safe", mode: "scan", commit: "a".repeat(40),
    dataset: "prod-sanitized-2026-09-01", backgroundMode: "normal", cacheMode: "warm",
    scan: {
      highestPassingRate: 24, firstFailingRate: 25,
      rateClassifications: [{ rate: 25, state: "FAIL", passes: 1, failures: 2,
        unstable: true, attempts: [{ outcome: "FAIL" }, { outcome: "PASS" }, { outcome: "FAIL" }] }],
      headroomPolicy: 0.8, calculatedHeadroomTarget: 19.2,
      safeCapacityCandidateTested: 20,
      safeCapacityCandidates: [{ rate: 20, passedSafeCapacityGates: true }],
      safeHomeOpensPerSecond: 20, failureReason: "home_p95_threshold",
      failureReasonDetail: { observed: 1480, threshold: 1000, unit: "ms" },
      primaryBottleneck: "postgres",
    },
    runtime: { scanRuntimeSeconds: 778, runtimeBudgetWarning: false,
      runtimeTargetExceeded: false, runtimeBreakdownSeconds: {
        environmentPreparation: 1, workflowValidation: 2, initialPrewarm: 3,
        targetedResets: 4, settlingDraining: 5, perLevelWarmups: 6,
        measuredLoad: 700, failureConfirmation: 20, boundaryNarrowing: 25,
        metricsCollection: 9, reportGeneration: 2, cleanup: 1,
      } },
    levels: [{ rate: 25, configuredWarmupSeconds: 15, actualWarmupSeconds: 15,
      homeP95Ms: 1480, homeP99Ms: 1900, httpErrorRate: 0 }],
    warnings: [], limitations: ["Lima is regression evidence, not production certification."],
  };
}

test("summary and report distinguish failure reason, bottleneck, and measured safe capacity", () => {
  const summary = buildSummary(input());
  assert.equal(summary.schema, "bara-perf-summary-v3");
  assert.equal(summary.highestPassingRate, 24);
  assert.equal(summary.firstFailingRate, 25);
  assert.equal(summary.calculatedHeadroomTarget, 19.2);
  assert.equal(summary.safeCapacityCandidateTested, 20);
  assert.equal(summary.safeHomeOpensPerSecond, 20);
  assert.equal(summary.failureReason, "home_p95_threshold");
  assert.equal(summary.primaryBottleneck, "postgres");

  const report = renderReport(summary);
  assert.match(report, /FIRST FAILURE/);
  assert.match(report, /Home p95.*1,480 ms/i);
  assert.match(report, /PRIMARY BOTTLENECK/);
  assert.match(report, /PostgreSQL/i);
  assert.match(report, /Calculated headroom target.*19\.2\/sec/i);
  assert.match(report, /Safe operating capacity.*20\/sec/i);
  assert.match(report, /UNSTABLE.*2 fail.*1 pass/i);
});

test("reports are written atomically to the canonical result files", (context) => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "bara-perf-report-"));
  context.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  const result = writeReports({ directory, input: input() });
  assert.equal(result.summaryPath, path.join(directory, "summary.json"));
  assert.equal(result.reportPath, path.join(directory, "report.md"));
  assert.equal(JSON.parse(fs.readFileSync(result.summaryPath)).schema, "bara-perf-summary-v3");
  assert.match(fs.readFileSync(result.reportPath, "utf8"), /Bara Home Capacity/);
  assert.deepEqual(fs.readdirSync(directory).sort(), ["manifest.json", "report.md", "summary.json"]);
});

test("first-run report has resource, queue, and Top SQL diagnostic sections", () => {
  const value = input();
  value.levels[0].queueGrowth = 1.2;
  value.levels[0].resources = { postgresCpuPercent: 94, nodeCpuPercent: 51,
    topSql: [{ queryId: "42", totalExecMs: 123, sharedBlocksHit: 90,
      sharedBlocksRead: 10, tempBlocksWritten: 2,
      normalizedQuery: "SELECT * FROM race_participants WHERE user_id = $1" }] };
  const report = renderReport(buildSummary(value));
  assert.match(report, /## Resource evidence/);
  assert.match(report, /## Queue evidence/);
  assert.match(report, /## Top SQL/);
  assert.match(report, /race_participants WHERE user_id = \$1/);
  assert.match(report, /90\/10\/2/);
});
