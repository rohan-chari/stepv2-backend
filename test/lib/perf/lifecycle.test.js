const assert = require("node:assert/strict");
const test = require("node:test");

const { runLevel, runtimeSummary } = require("../../../performance/lib/lifecycle");

function operations(log) {
  return {
    settle: async () => log.push("settle"),
    targetedReset: async () => log.push("targetedReset"),
    liveness: async () => log.push("liveness"),
    warmup: async () => log.push("warmup"),
    nonCacheFillingStabilize: async () => log.push("nonCacheFillingStabilize"),
    clearOwnedCache: async () => log.push("clearOwnedCache"),
    verifyOwnedCacheEmpty: async () => log.push("verifyOwnedCacheEmpty"),
    resetMetrics: async () => log.push("resetMetrics"),
    measure: async () => (log.push("measure"), { rate: 10 }),
    collectMetrics: async () => (log.push("collectMetrics"), {}),
  };
}

test("warm level preserves cache and excludes warmup from measurement epoch", async () => {
  const log = [];
  await runLevel({ rate: 10, cacheMode: "warm", warmupSeconds: 15,
    ceremonyTargetSeconds: 15, operations: operations(log) });
  assert.deepEqual(log, ["settle", "liveness", "warmup", "targetedReset", "resetMetrics",
    "measure", "collectMetrics"]);
  assert.equal(log.includes("clearOwnedCache"), false);
});

test("cold level clears only after non-cache-filling stabilization and never request-warms", async () => {
  const log = [];
  await runLevel({ rate: 10, cacheMode: "cold", warmupSeconds: 0,
    ceremonyTargetSeconds: 15, operations: operations(log) });
  assert.deepEqual(log, ["settle", "targetedReset", "liveness", "nonCacheFillingStabilize",
    "clearOwnedCache", "verifyOwnedCacheEmpty", "resetMetrics", "measure", "collectMetrics"]);
  assert.equal(log.includes("warmup"), false);
});

test("runtime summary has non-overlapping categories and warns above twenty minutes", () => {
  const values = {
    environmentPreparation: 1, workflowValidation: 2, initialPrewarm: 3,
    targetedResets: 4, settlingDraining: 5, perLevelWarmups: 6,
    measuredLoad: 1200, failureConfirmation: 7, boundaryNarrowing: 8,
    metricsCollection: 9, reportGeneration: 10, cleanup: 11,
  };
  const summary = runtimeSummary(values, { targetSeconds: 900, warningSeconds: 1200 });
  assert.equal(summary.scanRuntimeSeconds, Object.values(values).reduce((sum, value) => sum + value, 0));
  assert.equal(summary.runtimeBudgetWarning, true);
  assert.deepEqual(Object.keys(summary.runtimeBreakdownSeconds), Object.keys(values));
});
