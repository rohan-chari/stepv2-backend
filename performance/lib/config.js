const fs = require("node:fs");
const path = require("node:path");
const { CONFIG_SCHEMA, SUMMARY_SCHEMA } = require("./contracts");

function plainObject(value) {
  return value != null && typeof value === "object" && !Array.isArray(value);
}

function merge(left, right) {
  if (!plainObject(left) || !plainObject(right)) return right;
  const result = { ...left };
  for (const [key, value] of Object.entries(right)) {
    result[key] = plainObject(value) && plainObject(result[key])
      ? merge(result[key], value)
      : value;
  }
  return result;
}

function readJson(file) {
  return JSON.parse(fs.readFileSync(file, "utf8"));
}

function positiveInteger(value, name, { minimum = 1, maximum = 3600 } = {}) {
  if (!Number.isInteger(value) || value < minimum || value > maximum) {
    throw new Error(`${name} must be an integer from ${minimum} through ${maximum}`);
  }
}

function validateConfig(config, mode) {
  if (config.schema !== CONFIG_SCHEMA) throw new Error("unsupported performance config schema");
  if (!["smoke", "scan", "certify"].includes(mode)) throw new Error(`unsupported mode: ${mode}`);
  if (config.mode !== mode) throw new Error("performance mode layer mismatch");
  if (!["authenticated-home-reveal-v1", "authenticated-races-tab-reveal-v1"]
    .includes(config.workload?.name)) throw new Error("unsupported workload contract");
  if (!["production", "placement-churn"].includes(config.workload?.scoreShape)) {
    throw new Error("screen workload score shape must be production or placement-churn");
  }
  if (config.result?.summarySchema !== SUMMARY_SCHEMA) throw new Error("summary schema mismatch");
  positiveInteger(config.topology?.httpWorkers, "HTTP workers", { maximum: 16 });
  if (config.topology.httpWorkers !== 2) throw new Error("Home capacity requires exactly two HTTP workers");
  positiveInteger(config.smoke?.warmupSeconds, "smoke warmup", { minimum: 0 });
  positiveInteger(config.smoke?.measurementSeconds, "smoke measurement");
  positiveInteger(config.cache?.initialPrewarmRate, "initial prewarm rate", { maximum: 50 });
  positiveInteger(config.cache?.initialPrewarmMaxUsers, "initial prewarm users", { maximum: 5000 });
  positiveInteger(config.scan?.warmupSeconds, "scan warmup", { minimum: 0, maximum: 30 });
  positiveInteger(config.scan?.maxNormalWarmupSeconds, "scan maximum warmup", { maximum: 30 });
  if (config.scan.warmupSeconds > config.scan.maxNormalWarmupSeconds) {
    throw new Error("scan warmup exceeds maximum normal warmup");
  }
  positiveInteger(config.scan?.measurementSeconds, "scan measurement");
  const cohortSize = config.workload.cohortSize || 5000;
  positiveInteger(cohortSize, "screen workload cohort", { maximum: 5000 });
  const maximumRate = mode === "smoke" ? config.smoke.rate : Math.max(...config.scan.rates);
  const warmup = mode === "smoke" ? config.smoke.warmupSeconds : config.scan.warmupSeconds;
  const measurement = mode === "smoke" ? config.smoke.measurementSeconds : config.scan.measurementSeconds;
  if (maximumRate * (warmup + measurement) > cohortSize) {
    throw new Error("screen workload cohort is too small to separate warmup and measurement users");
  }
  if (config.scan.confirmBoundaryFailure !== true ||
      config.scan.classificationPolicy !== "majority" ||
      config.scan.maxAttemptsAtBoundaryRate !== 3) {
    throw new Error("scan boundary attempt policy must be confirmed majority with three attempts maximum");
  }
  if (!Array.isArray(config.scan.rates) || config.scan.rates.length === 0 ||
      config.scan.rates.some((rate) => !Number.isInteger(rate) || rate < 1 || rate > 500) ||
      config.scan.rates.some((rate, index) => index > 0 && rate <= config.scan.rates[index - 1])) {
    throw new Error("scan rates must be unique ascending integers from 1 through 500");
  }
  if (config.safeCapacity?.rounding !== "ceiling") throw new Error("safe-capacity rounding must be ceiling");
  if (!(config.safeCapacity.headroomFactor > 0 && config.safeCapacity.headroomFactor <= 1)) {
    throw new Error("safe-capacity headroom factor must be greater than zero and at most one");
  }
  positiveInteger(config.safeCapacity.fallbackStepPerSecond, "safe-capacity fallback step", { maximum: 100 });
  if (config.safeCapacity.requireMeasuredPass !== true) {
    throw new Error("safe-capacity requires a measured pass");
  }
  return Object.freeze(config);
}

function loadConfig({ repository, mode, workload = "home-open", overrides = {} } = {}) {
  const root = path.resolve(repository || path.join(__dirname, "../.."));
  const configRoot = path.join(root, "performance", "config");
  const base = readJson(path.join(configRoot, "default.json"));
  const modeLayer = readJson(path.join(configRoot, `${mode}.json`));
  const selected = base.workloads?.[workload];
  if (!selected) throw new Error(`unsupported workload: ${workload}`);
  const thresholds = base.workloadThresholds?.[workload] || base.thresholds;
  return validateConfig(merge(merge(merge(base, modeLayer), {
    workload: selected,
    thresholds,
  }), overrides), mode);
}

module.exports = { loadConfig, merge, validateConfig };
