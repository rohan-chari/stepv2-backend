const RUNTIME_CATEGORIES = Object.freeze([
  "environmentPreparation",
  "workflowValidation",
  "initialPrewarm",
  "targetedResets",
  "settlingDraining",
  "perLevelWarmups",
  "measuredLoad",
  "failureConfirmation",
  "boundaryNarrowing",
  "metricsCollection",
  "reportGeneration",
  "cleanup",
]);

function seconds(startedAt, now) {
  return Math.max(0, (now() - startedAt) / 1000);
}

async function timed(operation, now) {
  const startedAt = now();
  const value = await operation();
  return { value, seconds: seconds(startedAt, now) };
}

async function runLevel({ rate, cacheMode, warmupSeconds, ceremonyTargetSeconds,
  operations, now = Date.now } = {}) {
  if (!Number.isInteger(rate) || rate < 1 || !["warm", "cold"].includes(cacheMode)) {
    throw new Error("level requires a positive rate and explicit cache mode");
  }
  const required = ["settle", "targetedReset", "liveness", "resetMetrics", "measure", "collectMetrics"];
  for (const name of required) if (typeof operations?.[name] !== "function") {
    throw new Error(`level operation is missing: ${name}`);
  }
  const timings = { targetedResetSeconds: 0, settlingDrainingSeconds: 0,
    livenessSeconds: 0, warmupSeconds: 0, metricResetSeconds: 0,
    measurementSeconds: 0, metricsCollectionSeconds: 0 };
  let result = await timed(operations.settle, now); timings.settlingDrainingSeconds = result.seconds;
  result = await timed(operations.targetedReset, now); timings.targetedResetSeconds = result.seconds;
  result = await timed(operations.liveness, now); timings.livenessSeconds = result.seconds;
  if (cacheMode === "warm") {
    if (typeof operations.warmup !== "function") throw new Error("warm level requires warmup");
    result = await timed(() => operations.warmup({ rate, warmupSeconds }), now);
    timings.warmupSeconds = result.seconds;
  } else {
    for (const name of ["nonCacheFillingStabilize", "clearOwnedCache", "verifyOwnedCacheEmpty"]) {
      if (typeof operations[name] !== "function") throw new Error(`cold level operation is missing: ${name}`);
      result = await timed(operations[name], now);
      timings[`${name}Seconds`] = result.seconds;
    }
  }
  result = await timed(operations.resetMetrics, now); timings.metricResetSeconds = result.seconds;
  const measurement = await timed(() => operations.measure({ rate }), now);
  timings.measurementSeconds = measurement.seconds;
  const collection = await timed(operations.collectMetrics, now);
  timings.metricsCollectionSeconds = collection.seconds;
  const ceremonySeconds = Object.entries(timings)
    .filter(([name]) => !["warmupSeconds", "measurementSeconds"].includes(name))
    .reduce((sum, [, value]) => sum + value, 0);
  return { rate, cacheMode, configuredWarmupSeconds: warmupSeconds,
    actualWarmupSeconds: timings.warmupSeconds, timings, ceremonySeconds,
    ceremonyBudgetWarning: ceremonySeconds > ceremonyTargetSeconds,
    measurement: measurement.value, metrics: collection.value };
}

function runtimeSummary(values = {}, { targetSeconds, warningSeconds } = {}) {
  const runtimeBreakdownSeconds = Object.fromEntries(RUNTIME_CATEGORIES.map((name) =>
    [name, Number(values[name] || 0)]));
  if (Object.values(runtimeBreakdownSeconds).some((value) => !Number.isFinite(value) || value < 0)) {
    throw new Error("runtime breakdown requires finite non-negative values");
  }
  const scanRuntimeSeconds = Object.values(runtimeBreakdownSeconds).reduce((sum, value) => sum + value, 0);
  return { scanRuntimeSeconds, runtimeTargetExceeded: scanRuntimeSeconds > targetSeconds,
    runtimeBudgetWarning: scanRuntimeSeconds > warningSeconds, runtimeBreakdownSeconds };
}

module.exports = { RUNTIME_CATEGORIES, runLevel, runtimeSummary };
