const { ValidationError } = require("../../../shared/errors/AppError");
const redisCacheDefault = require("../../../shared/cache/redisCache");
const cacheKeysDefault = require("../../../shared/cache/cacheKeys");
const {
  ENDPOINTS,
  createHistogram,
  mergeHistograms,
  histogramPercentile,
} = require("../../../shared/observability/databasePoolTelemetry");
const {
  STEP_HOUR_SCHEMA,
  STEP_HISTORY_START_SCHEMA,
  STEP_MINUTE_SCHEMA,
} = require("../../../shared/observability/telemetryRedisContract");

const EXPECTED = [
  { role: "http", instance: "0" },
  { role: "http", instance: "1" },
  { role: "resolution", instance: "0" },
  { role: "cron", instance: "0" },
];
const WINDOWS = [
  { window: "60m", windowMinutes: 60 },
  { window: "24h", windowMinutes: 1440 },
  { window: "7d", windowMinutes: 10080 },
];
const MAX_SAFE = Number.MAX_SAFE_INTEGER;

function isObject(value) {
  return value != null && typeof value === "object" && !Array.isArray(value);
}

function hasExactKeys(value, keys) {
  if (!isObject(value)) return false;
  const actual = Object.keys(value).sort();
  const expected = [...keys].sort();
  return actual.length === expected.length && actual.every((key, index) => key === expected[index]);
}

function integer(value, min = 0, max = MAX_SAFE) {
  return Number.isSafeInteger(value) && value >= min && value <= max;
}

function finite(value, min, max) {
  return typeof value === "number" && Number.isFinite(value) && value >= min && value <= max;
}

function validIsoPair(iso, milliseconds) {
  if (typeof iso !== "string" || !integer(milliseconds)) return false;
  const parsed = Date.parse(iso);
  return Number.isFinite(parsed) && Math.abs(parsed - milliseconds) <= 1;
}

function validHistogram(histogram) {
  if (!isObject(histogram) || !integer(histogram.observations) ||
      !finite(histogram.sumMs, 0, 86_400_000 * Math.max(1, histogram.observations)) ||
      !Array.isArray(histogram.counts) || histogram.counts.length !== 12) return false;
  if (histogram.observations === 0) {
    if (histogram.maxMs !== null) return false;
  } else if (!finite(histogram.maxMs, 0, 86_400_000)) return false;
  let prior = -1;
  for (const count of histogram.counts) {
    if (!integer(count) || count < prior || count > histogram.observations) return false;
    prior = count;
  }
  return histogram.counts.at(-1) === histogram.observations;
}

function validCounterBlock(value) {
  const requiredCounters = [
    "requests", "successes", "failures", "queuedTimeouts",
    "validation4xx", "auth4xx", "poolCheckoutTimeouts", "transactionErrors", "server5xx",
  ];
  return isObject(value) && requiredCounters.every((key) => integer(value[key])) &&
    value.successes + value.failures === value.requests &&
    value.validation4xx + value.auth4xx + value.poolCheckoutTimeouts +
      value.transactionErrors + value.server5xx === value.failures &&
    value.queuedTimeouts === value.poolCheckoutTimeouts &&
    [
      "requestDurationHistogram",
      "authenticationDurationHistogram",
      "checkoutWaitHistogram",
      "transactionDurationHistogram",
    ].every((key) => validHistogram(value[key]));
}

function validStepIngestion(value) {
  if (!validCounterBlock(value) || !Array.isArray(value.endpoints) || value.endpoints.length !== 3 ||
      !Array.isArray(value.phases)) return false;
  if (value.endpoints.some((row, index) => !isObject(row) || row.endpoint !== ENDPOINTS[index] || !validCounterBlock(row))) {
    return false;
  }
  const sums = [
    "requests", "successes", "failures", "queuedTimeouts",
    "validation4xx", "auth4xx", "poolCheckoutTimeouts", "transactionErrors", "server5xx",
  ];
  if (sums.some((key) => value.endpoints.reduce((total, row) => total + row[key], 0) !== value[key])) {
    return false;
  }
  const allowedPhases = new Set([
    "authentication", "checkout_wait", "transaction_total", "scoring_state", "daily",
    "sample", "scoring_generation", "active_race", "durable_enqueue",
    "summary_finalization", "post_commit",
  ]);
  const names = new Set();
  for (const phase of value.phases) {
    if (!isObject(phase) || !allowedPhases.has(phase.phase) || names.has(phase.phase) ||
        !integer(phase.observations) || !finite(phase.samplingRate, 0, 1) ||
        !validHistogram(phase.histogram) || phase.histogram.observations !== phase.observations) return false;
    names.add(phase.phase);
  }
  return true;
}

function validateSnapshot(value, expected, nowMs) {
  if (!isObject(value) || value.schema !== "database-pool-telemetry-snapshot-v1" ||
      value.role !== expected.role || String(value.instance) !== expected.instance ||
      typeof value.bootId !== "string" || value.bootId.length < 1 || value.bootId.length > 128 ||
      !validIsoPair(value.bootStartedAt, value.bootStartedAtMs) ||
      !validIsoPair(value.capturedAt, value.capturedAtMs) ||
      value.capturedAtMs > nowMs + 300_000 || value.bootStartedAtMs > value.capturedAtMs + 300_000 ||
      !integer(value.coverageMinutes, 0, 60) || !Array.isArray(value.buckets) ||
      value.buckets.length !== value.coverageMinutes ||
      (value.coverageMinutes === 0 && (value.oldestBucketAt !== null || value.newestBucketAt !== null))) {
    return { valid: false, reason: "malformed" };
  }
  if (nowMs - value.capturedAtMs > 150_000) return { valid: false, reason: "stale" };
  const pool = value.pool;
  if (!isObject(pool) || !integer(pool.max, 1, 1_000_000) ||
      (pool.configSource != null && (typeof pool.configSource !== "string" ||
        !/^(?:DATABASE_POOL_MAX_(?:HTTP|RESOLUTION|CRON|ALL|DEFAULT)|DB_POOL_MAX|compatibility-default|capacity-default)$/.test(pool.configSource))) ||
      !["total", "idle", "nonIdle", "checkedOut", "waiting"].every((key) => integer(pool[key], 0, 1_000_000)) ||
      pool.idle > pool.total || pool.nonIdle !== pool.total - pool.idle ||
      pool.checkedOut > pool.nonIdle || pool.total > pool.max) return { valid: false, reason: "malformed" };
  const processData = value.process;
  if (!isObject(processData) || !integer(processData.rssBytes) ||
      !finite(processData.cpuOneCorePercent, 0, 100) || !finite(processData.eventLoopP99Ms, 0, 86_400_000)) {
    return { valid: false, reason: "malformed" };
  }
  const seen = new Set();
  const captureMinuteMs = Math.floor(value.capturedAtMs / 60_000) * 60_000;
  let previousMinuteStartedAtMs = null;
  for (const bucket of value.buckets) {
    if (!isObject(bucket) || !integer(bucket.minuteStartedAtMs) || bucket.minuteStartedAtMs % 60_000 !== 0 ||
        !validIsoPair(bucket.minuteStartedAt, bucket.minuteStartedAtMs) || seen.has(bucket.minuteStartedAtMs) ||
        bucket.minuteStartedAtMs >= captureMinuteMs ||
        bucket.minuteStartedAtMs < captureMinuteMs - 60 * 60_000 ||
        (previousMinuteStartedAtMs != null && bucket.minuteStartedAtMs <= previousMinuteStartedAtMs)) {
      return { valid: false, reason: "malformed" };
    }
    seen.add(bucket.minuteStartedAtMs);
    previousMinuteStartedAtMs = bucket.minuteStartedAtMs;
    if (!isObject(bucket.interval) || ![
      "acquisitions", "releases", "queuedCheckouts", "queuedTimeouts",
      "physicalAttempts", "physicalTimeouts", "physicalErrors",
    ].every((key) => integer(bucket.interval[key])) ||
      !validHistogram(bucket.queuedWaitHistogram) ||
      !validHistogram(bucket.physicalConnectionDurationHistogram) ||
      (expected.role === "http" && !validStepIngestion(bucket.stepIngestion)) ||
      (expected.role !== "http" && bucket.stepIngestion != null)) return { valid: false, reason: "malformed" };
  }
  if (value.coverageMinutes > 0) {
    const ordered = [...seen].sort((a, b) => a - b);
    if (value.oldestBucketAt !== new Date(ordered[0]).toISOString() ||
        value.newestBucketAt !== new Date(ordered.at(-1)).toISOString()) return { valid: false, reason: "malformed" };
  }
  return { valid: true, value };
}

function sumIntervals(buckets) {
  const fields = [
    "acquisitions", "releases", "queuedCheckouts", "queuedTimeouts",
    "physicalAttempts", "physicalTimeouts", "physicalErrors",
  ];
  const result = Object.fromEntries(fields.map((field) => [field, 0]));
  for (const bucket of buckets) for (const field of fields) result[field] += bucket.interval[field];
  const waits = mergeHistograms(buckets.map((bucket) => bucket.queuedWaitHistogram));
  if (waits.observations > 0) {
    result.queuedWaitP95Ms = histogramPercentile(waits, 0.95);
    result.queuedWaitMaxMs = waits.maxMs;
  }
  return result;
}

function sumCounterBlocks(blocks) {
  const target = {
    requests: 0, successes: 0, failures: 0, queuedTimeouts: 0,
    validation4xx: 0, auth4xx: 0, poolCheckoutTimeouts: 0, transactionErrors: 0, server5xx: 0,
  };
  for (const block of blocks) {
    for (const key of Object.keys(target)) target[key] += Number(block?.[key]) || 0;
  }
  const request = mergeHistograms(blocks.map((block) => block.requestDurationHistogram));
  const transaction = mergeHistograms(blocks.map((block) => block.transactionDurationHistogram));
  return {
    ...target,
    ...(request.observations > 0 ? { latencyP95Ms: histogramPercentile(request, 0.95) } : {}),
    ...(transaction.observations > 0 ? { transactionP95Ms: histogramPercentile(transaction, 0.95) } : {}),
  };
}

function processStatus(snapshot, last60m) {
  const stepBlocks = snapshot.buckets.map((bucket) => bucket.stepIngestion).filter(Boolean);
  const step = sumCounterBlocks(stepBlocks);
  if (last60m.queuedTimeouts > 0 || last60m.physicalTimeouts > 0 || last60m.physicalErrors > 0 ||
      step.poolCheckoutTimeouts > 0 || step.transactionErrors > 0 || step.server5xx > 0) return "degraded";
  if (snapshot.pool.waiting > 0 || (last60m.queuedWaitP95Ms ?? 0) >= 100 ||
      (last60m.queuedWaitMaxMs ?? 0) >= 1000) return "pressure";
  if (snapshot.coverageMinutes < 60) return "unknown";
  return "healthy";
}

function processRow(snapshot) {
  const last60m = sumIntervals(snapshot.buckets);
  return {
    role: snapshot.role,
    instance: String(snapshot.instance),
    status: processStatus(snapshot, last60m),
    capturedAt: snapshot.capturedAt,
    coverageMinutes: snapshot.coverageMinutes,
    oldestBucketAt: snapshot.oldestBucketAt,
    newestBucketAt: snapshot.newestBucketAt,
    pool: snapshot.pool,
    last60m,
    process: snapshot.process,
  };
}

function combinedStepIngestion(snapshots) {
  const http = snapshots.filter((snapshot) => snapshot.role === "http");
  if (http.length === 0) return null;
  const blocks = http.flatMap((snapshot) => snapshot.buckets.map((bucket) => bucket.stepIngestion));
  const aggregate = sumCounterBlocks(blocks);
  const endpoints = ENDPOINTS.map((endpoint) => {
    const rows = blocks.map((block) => block.endpoints.find((row) => row.endpoint === endpoint));
    return { endpoint, ...sumCounterBlocks(rows) };
  });
  const phaseGroups = new Map();
  for (const block of blocks) for (const phase of block.phases) {
    const key = `${phase.phase}:${phase.samplingRate}`;
    if (!phaseGroups.has(key)) phaseGroups.set(key, []);
    phaseGroups.get(key).push(phase);
  }
  const phases = [...phaseGroups.values()].map((rows) => {
    const merged = mergeHistograms(rows.map((row) => row.histogram));
    return {
      phase: rows[0].phase,
      observations: merged.observations,
      samplingRate: rows[0].samplingRate,
      ...(merged.observations > 0 ? { p95Ms: histogramPercentile(merged, 0.95), maxMs: merged.maxMs } : {}),
    };
  }).sort((left, right) => left.phase.localeCompare(right.phase));
  return {
    contributingHttpProcesses: http.length,
    requests: aggregate.requests,
    successes: aggregate.successes,
    failures: aggregate.failures,
    queuedTimeouts: aggregate.queuedTimeouts,
    ...(aggregate.latencyP95Ms != null ? { latencyP95Ms: aggregate.latencyP95Ms } : {}),
    ...(aggregate.transactionP95Ms != null ? { transactionP95Ms: aggregate.transactionP95Ms } : {}),
    phases,
    endpoints: endpoints.map((row) => ({
      endpoint: row.endpoint,
      requests: row.requests,
      successes: row.successes,
      failures: row.failures,
      queuedTimeouts: row.queuedTimeouts,
      ...(row.latencyP95Ms != null ? { latencyP95Ms: row.latencyP95Ms } : {}),
      ...(row.transactionP95Ms != null ? { transactionP95Ms: row.transactionP95Ms } : {}),
    })),
  };
}

function hourKeysFor(nowMs, cacheKeys) {
  const endMinute = Math.floor(nowMs / 60_000) * 60_000;
  const firstHour = Math.floor((endMinute - 10_080 * 60_000) / 3_600_000) * 3_600_000;
  const lastHour = Math.floor((endMinute - 1) / 3_600_000) * 3_600_000;
  const keys = [];
  for (let at = firstHour; at <= lastHour && keys.length < 169; at += 3_600_000) keys.push(cacheKeys.stepIngestionHour(at));
  return keys;
}

function parseHistoryRedis(raw, hourKeys) {
  if (!raw?.ok || !hasExactKeys(raw.start, ["schema", "collectionStartedMinuteMs"]) ||
      raw.start.schema !== STEP_HISTORY_START_SCHEMA ||
      !integer(raw.start.collectionStartedMinuteMs) || raw.start.collectionStartedMinuteMs % 60_000 !== 0) {
    return { status: "unavailable", collectionStartedMinuteMs: null, minutes: [] };
  }
  const minuteMap = new Map();
  let malformed = (raw.oversizeKeys || []).length > 0;
  for (let hourIndex = 0; hourIndex < hourKeys.length; hourIndex += 1) {
    const fields = raw.hours?.[hourIndex];
    if (fields == null || Object.keys(fields).length === 0) continue;
    if (!isObject(fields) || fields.schema !== STEP_HOUR_SCHEMA) { malformed = true; continue; }
    const hourItems = new Map();
    let hourMalformed = false;
    for (const [field, value] of Object.entries(fields)) {
      if (field === "schema") continue;
      const match = /^(c|o|m):(\d+):http:([01])(?::([A-Za-z0-9._-]{1,128}))?$/.exec(field);
      if (!match || ((match[1] === "c" || match[1] === "o") && match[4] !== undefined) ||
          (match[1] === "m" && match[4] === undefined)) {
        hourMalformed = true;
        continue;
      }
      const minuteStartedAtMs = Number(match[2]);
      const expectedHourKey = hourKeys[hourIndex];
      if (!integer(minuteStartedAtMs) || minuteStartedAtMs % 60_000 !== 0 ||
          cacheKeysDefault.stepIngestionHour(minuteStartedAtMs) !== expectedHourKey) {
        hourMalformed = true;
        continue;
      }
      const key = `${minuteStartedAtMs}:${match[3]}`;
      if (!hourItems.has(key)) hourItems.set(key, { minuteStartedAtMs, instance: match[3], count: null, overflow: false, emissions: [] });
      const item = hourItems.get(key);
      if (match[1] === "c") {
        const count = Number(value);
        if (!integer(count, 0, 2) || item.count != null) hourMalformed = true;
        else item.count = count;
      } else if (match[1] === "o") {
        if (value !== "1" || item.overflow) hourMalformed = true;
        else item.overflow = true;
      } else {
        try {
          const payload = JSON.parse(value);
          if (!hasExactKeys(payload, ["schema", "minuteStartedAtMs", "role", "instance", "bootId", "endpoints"]) ||
              payload.schema !== STEP_MINUTE_SCHEMA || payload.minuteStartedAtMs !== minuteStartedAtMs ||
              payload.role !== "http" || String(payload.instance) !== match[3] || payload.bootId !== match[4] ||
              !hasExactKeys(payload.endpoints, ENDPOINTS)) throw new Error("bad payload");
          const endpoints = {};
          for (const endpoint of ENDPOINTS) {
            const counts = payload.endpoints[endpoint];
            if (!Array.isArray(counts) || counts.length !== 7 || counts.some((count) => !integer(count)) ||
                counts.slice(1).reduce((sum, count) => sum + count, 0) !== counts[0]) throw new Error("bad counts");
            endpoints[endpoint] = counts;
          }
          item.emissions.push({ bootId: payload.bootId, endpoints });
        } catch { hourMalformed = true; }
      }
    }
    for (const item of hourItems.values()) {
      if (item.count !== item.emissions.length || item.emissions.length > 2) hourMalformed = true;
    }
    if (hourMalformed) {
      malformed = true;
      continue;
    }
    for (const [key, item] of hourItems) minuteMap.set(key, item);
  }
  const byMinute = new Map();
  for (const item of minuteMap.values()) {
    if (!byMinute.has(item.minuteStartedAtMs)) byMinute.set(item.minuteStartedAtMs, []);
    byMinute.get(item.minuteStartedAtMs).push(item);
  }
  const minutes = [...byMinute.entries()].map(([minuteStartedAtMs, workers]) => ({ minuteStartedAtMs, workers }));
  return {
    status: malformed ? "partial" : (minutes.length > 0 ? "available" : "partial"),
    collectionStartedMinuteMs: raw.start.collectionStartedMinuteMs,
    minutes,
  };
}

function zeroWindow(window) {
  return {
    window: window.window,
    windowMinutes: window.windowMinutes,
    collectionStatus: "collecting",
    completeCoverageMinutes: 0,
    partialCoverageMinutes: 0,
    requests: 0,
    successes: 0,
    requestFailures: 0,
    serverFailures: 0,
    endpoints: ENDPOINTS.map((endpoint) => ({ endpoint, requests: 0, successes: 0, requestFailures: 0, serverFailures: 0 })),
  };
}

function addEmission(target, emission) {
  for (const endpoint of ENDPOINTS) {
    const counts = emission.endpoints[endpoint];
    const row = target.endpoints.find((item) => item.endpoint === endpoint);
    row.requests += counts[0];
    row.successes += counts[1];
    row.requestFailures += counts[0] - counts[1];
    row.serverFailures += counts[4] + counts[5] + counts[6];
  }
}

function failureWindows(history, nowMs) {
  if (!history || history.status === "unavailable" || history.collectionStartedMinuteMs == null) return null;
  const byMinute = new Map((history.minutes || []).map((row) => [row.minuteStartedAtMs, row]));
  const endMinute = Math.floor(nowMs / 60_000) * 60_000;
  return WINDOWS.map((window) => {
    const result = zeroWindow(window);
    const start = endMinute - window.windowMinutes * 60_000;
    const expectedStart = Math.max(start, history.collectionStartedMinuteMs);
    for (let at = expectedStart; at < endMinute; at += 60_000) {
      const minute = byMinute.get(at);
      const observedWorkers = (minute?.workers || []).filter((worker) =>
        ["0", "1"].includes(worker.instance) &&
        worker.count === worker.emissions.length && worker.count >= 1 && worker.count <= 2);
      const completeIdentities = new Set(observedWorkers
        .filter((worker) => !worker.overflow)
        .map((worker) => worker.instance));
      if (completeIdentities.size === 2) result.completeCoverageMinutes += 1;
      else result.partialCoverageMinutes += 1;
      for (const worker of observedWorkers) for (const emission of worker.emissions) addEmission(result, emission);
    }
    for (const row of result.endpoints) {
      result.requests += row.requests;
      result.successes += row.successes;
      result.requestFailures += row.requestFailures;
      result.serverFailures += row.serverFailures;
    }
    result.collectionStatus = result.completeCoverageMinutes === window.windowMinutes &&
      result.partialCoverageMinutes === 0 ? "complete" : "collecting";
    return result;
  });
}

function resolvedHistoryStatus(history, nowMs) {
  if (!history || history.status === "unavailable" || history.collectionStartedMinuteMs == null) {
    return "unavailable";
  }
  if (history.status === "partial") return "partial";
  const endMinute = Math.floor(nowMs / 60_000) * 60_000;
  const startMinute = Math.max(
    history.collectionStartedMinuteMs,
    endMinute - 10_080 * 60_000,
  );
  const byMinute = new Map((history.minutes || []).map((row) => [row.minuteStartedAtMs, row]));
  for (let at = startMinute; at < endMinute; at += 60_000) {
    const workers = byMinute.get(at)?.workers || [];
    const complete = ["0", "1"].every((instance) => {
      const worker = workers.find((row) => row.instance === instance);
      return worker && !worker.overflow && worker.count === worker.emissions.length &&
        worker.count >= 1 && worker.count <= 2;
    });
    if (!complete) return "partial";
  }
  return "available";
}

function overallStatus(status, rows) {
  if (status === "unavailable") return "unknown";
  if (status === "partial") return "degraded";
  if (rows.some((row) => row.status === "degraded")) return "degraded";
  if (rows.some((row) => row.status === "pressure")) return "pressure";
  if (rows.some((row) => row.status === "unknown")) return "unknown";
  return "healthy";
}

function buildGetSystemHealth(dependencies = {}) {
  const redisCache = dependencies.redisCache || redisCacheDefault;
  const cacheKeys = dependencies.cacheKeys || cacheKeysDefault;
  const now = dependencies.now || (() => new Date());
  const snapshotReader = dependencies.snapshotReader || (() =>
    redisCache.readDatabasePoolTelemetrySnapshots(
      EXPECTED.map(({ role, instance }) => cacheKeys.databasePoolTelemetry(role, instance)),
    ));
  const historyReader = dependencies.historyReader || (async ({ nowMs }) => {
    const hourKeys = hourKeysFor(nowMs, cacheKeys);
    const raw = await redisCache.readStepIngestionHistory({
      startKey: cacheKeys.stepIngestionHistoryStart(),
      hourKeys,
    });
    return parseHistoryRedis(raw, hourKeys);
  });

  return async function getSystemHealth({ window = "60m" } = {}) {
    if (window !== "60m") throw new ValidationError("Unsupported system-health window", "INVALID_WINDOW");
    const current = now();
    const nowMs = current.getTime();
    const [snapshotResult, history] = await Promise.all([
      snapshotReader(),
      historyReader({ nowMs }),
    ]);
    const historyStatus = resolvedHistoryStatus(history, nowMs);
    const valid = [];
    const missingProcesses = [];
    const values = snapshotResult?.ok && Array.isArray(snapshotResult.values) ? snapshotResult.values : [];
    for (let index = 0; index < EXPECTED.length; index += 1) {
      const expected = EXPECTED[index];
      const value = values[index];
      if (!snapshotResult?.ok) {
        missingProcesses.push({ ...expected, reason: "unavailable" });
        continue;
      }
      if (value === undefined) {
        missingProcesses.push({ ...expected, reason: "malformed" });
        continue;
      }
      if (value === null) {
        missingProcesses.push({ ...expected, reason: "missing" });
        continue;
      }
      const parsed = validateSnapshot(value, expected, nowMs);
      if (!parsed.valid) missingProcesses.push({ ...expected, reason: parsed.reason });
      else valid.push(parsed.value);
    }
    const status = valid.length === 0 ? "unavailable" : valid.length === 4 ? "available" : "partial";
    if (valid.length === 0) {
      return {
        schema: "admin-system-health-v1",
        status,
        overall: "unknown",
        historyStatus,
        generatedAt: current.toISOString(),
        windowMinutes: 60,
        windowCoverageMinutes: 0,
        expectedProcesses: 4,
        freshProcesses: 0,
        missingProcesses,
        processes: [],
        stepIngestion: null,
        failureWindows: failureWindows(history, nowMs),
      };
    }
    const processes = valid.map(processRow);
    return {
      schema: "admin-system-health-v1",
      status,
      overall: overallStatus(status, processes),
      historyStatus,
      generatedAt: current.toISOString(),
      windowMinutes: 60,
      windowCoverageMinutes: Math.min(...valid.map((snapshot) => snapshot.coverageMinutes)),
      expectedProcesses: 4,
      freshProcesses: valid.length,
      missingProcesses,
      processes,
      stepIngestion: combinedStepIngestion(valid),
      failureWindows: failureWindows(history, nowMs),
    };
  };
}

const getSystemHealth = buildGetSystemHealth();

module.exports = {
  EXPECTED,
  WINDOWS,
  buildGetSystemHealth,
  getSystemHealth,
  validateSnapshot,
  parseHistoryRedis,
};
