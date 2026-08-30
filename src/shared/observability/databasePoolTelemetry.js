const { randomUUID } = require("node:crypto");
const { monitorEventLoopDelay } = require("node:perf_hooks");
const {
  recordStepTelemetryPhase,
} = require("./stepTelemetryContext");
const {
  SNAPSHOT_SERIALIZED_CAP_BYTES,
} = require("./telemetryRedisContract");

const HISTOGRAM_BOUNDARIES_MS = [1, 5, 10, 25, 50, 100, 250, 500, 1000, 2500, 5000];
const ENDPOINTS = ["steps", "samples", "sync-v2"];
const OUTCOMES = [
  "success",
  "validation_4xx",
  "auth_4xx",
  "pool_checkout_timeout",
  "transaction_error",
  "server_5xx",
];
const PHASES = new Set([
  "authentication",
  "checkout_wait",
  "transaction_total",
  "scoring_state",
  "daily",
  "sample",
  "scoring_generation",
  "active_race",
  "durable_enqueue",
  "summary_finalization",
  "post_commit",
]);
const SUPPORTED_IDENTITIES = new Set(["http:0", "http:1", "resolution:0", "cron:0"]);
const SNAPSHOT_SCHEMA = "database-pool-telemetry-snapshot-v1";
const LOG_SCHEMA = "database-pool-telemetry-v1";
const SNAPSHOT_TTL_SECONDS = 150;
const HISTORY_TTL_SECONDS = 8 * 24 * 60 * 60;

function createHistogram() {
  return {
    observations: 0,
    sumMs: 0,
    maxMs: null,
    counts: Array(HISTOGRAM_BOUNDARIES_MS.length + 1).fill(0),
  };
}

function validDuration(value) {
  const number = Number(value);
  return Number.isFinite(number) && number >= 0 && number <= 86_400_000
    ? number
    : null;
}

function observeHistogram(histogram, durationMs) {
  const value = validDuration(durationMs);
  if (value == null) return false;
  histogram.observations += 1;
  histogram.sumMs += value;
  histogram.maxMs = histogram.maxMs == null ? value : Math.max(histogram.maxMs, value);
  let bucket = HISTOGRAM_BOUNDARIES_MS.findIndex((boundary) => value <= boundary);
  if (bucket < 0) bucket = HISTOGRAM_BOUNDARIES_MS.length;
  for (let index = bucket; index < histogram.counts.length; index += 1) {
    histogram.counts[index] += 1;
  }
  return true;
}

function cloneHistogram(histogram) {
  return {
    observations: histogram.observations,
    sumMs: histogram.sumMs,
    maxMs: histogram.maxMs,
    counts: histogram.counts.slice(),
  };
}

function mergeHistograms(histograms) {
  const merged = createHistogram();
  for (const histogram of histograms || []) {
    if (!histogram || !Array.isArray(histogram.counts) || histogram.counts.length !== 12) continue;
    merged.observations += Number(histogram.observations) || 0;
    merged.sumMs += Number(histogram.sumMs) || 0;
    if (histogram.maxMs != null) {
      merged.maxMs = merged.maxMs == null
        ? Number(histogram.maxMs)
        : Math.max(merged.maxMs, Number(histogram.maxMs));
    }
    for (let index = 0; index < merged.counts.length; index += 1) {
      merged.counts[index] += Number(histogram.counts[index]) || 0;
    }
  }
  return merged;
}

function histogramPercentile(histogram, percentile) {
  if (!histogram || histogram.observations <= 0) return null;
  const rank = Math.max(1, Math.ceil(histogram.observations * percentile));
  const index = histogram.counts.findIndex((count) => count >= rank);
  if (index < 0) return histogram.maxMs;
  if (index >= HISTOGRAM_BOUNDARIES_MS.length) return histogram.maxMs;
  return Math.min(HISTOGRAM_BOUNDARIES_MS[index], histogram.maxMs);
}

function emptyInterval() {
  return {
    acquisitions: 0,
    releases: 0,
    queuedCheckouts: 0,
    queuedTimeouts: 0,
    physicalAttempts: 0,
    physicalTimeouts: 0,
    physicalErrors: 0,
  };
}

function emptyEndpoint(endpoint) {
  return {
    endpoint,
    requests: 0,
    successes: 0,
    failures: 0,
    queuedTimeouts: 0,
    validation4xx: 0,
    auth4xx: 0,
    poolCheckoutTimeouts: 0,
    transactionErrors: 0,
    server5xx: 0,
    requestDurationHistogram: createHistogram(),
    authenticationDurationHistogram: createHistogram(),
    checkoutWaitHistogram: createHistogram(),
    transactionDurationHistogram: createHistogram(),
  };
}

function emptyStepIngestion() {
  return {
    requests: 0,
    successes: 0,
    failures: 0,
    queuedTimeouts: 0,
    validation4xx: 0,
    auth4xx: 0,
    poolCheckoutTimeouts: 0,
    transactionErrors: 0,
    server5xx: 0,
    requestDurationHistogram: createHistogram(),
    authenticationDurationHistogram: createHistogram(),
    checkoutWaitHistogram: createHistogram(),
    transactionDurationHistogram: createHistogram(),
    endpoints: ENDPOINTS.map(emptyEndpoint),
    phases: [],
  };
}

function cloneEndpoint(endpoint) {
  return {
    ...endpoint,
    requestDurationHistogram: cloneHistogram(endpoint.requestDurationHistogram),
    authenticationDurationHistogram: cloneHistogram(endpoint.authenticationDurationHistogram),
    checkoutWaitHistogram: cloneHistogram(endpoint.checkoutWaitHistogram),
    transactionDurationHistogram: cloneHistogram(endpoint.transactionDurationHistogram),
  };
}

function cloneStepIngestion(step) {
  return {
    ...step,
    requestDurationHistogram: cloneHistogram(step.requestDurationHistogram),
    authenticationDurationHistogram: cloneHistogram(step.authenticationDurationHistogram),
    checkoutWaitHistogram: cloneHistogram(step.checkoutWaitHistogram),
    transactionDurationHistogram: cloneHistogram(step.transactionDurationHistogram),
    endpoints: step.endpoints.map(cloneEndpoint),
    phases: step.phases.map((phase) => ({
      ...phase,
      histogram: cloneHistogram(phase.histogram),
    })),
  };
}

function isPendingCheckoutTimeout(error) {
  return /timeout exceeded when trying to connect/i.test(String(error?.message || ""));
}

function isPhysicalTimeout(error) {
  const code = String(error?.code || "").toUpperCase();
  return ["ETIMEDOUT", "ESOCKETTIMEDOUT", "CONNECT_TIMEOUT"].includes(code) ||
    /(?:connect|connection).*tim(?:e|ed) ?out/i.test(String(error?.message || ""));
}

function monotonicElapsedMs(nowNs, startedNs) {
  return Math.max(0, Number(nowNs() - startedNs) / 1e6);
}

function createDatabasePoolTelemetry({
  pool,
  role = process.env.STEPS_PROCESS_ROLE || "all",
  instance = process.env.NODE_APP_INSTANCE == null ? "0" : String(process.env.NODE_APP_INSTANCE),
  poolConfigSource = null,
  nowMs = Date.now,
  monotonicNowNs = () => process.hrtime.bigint(),
  bootId = randomUUID(),
  logger = console,
  redisCache = null,
  cacheKeys = null,
  setTimer = setTimeout,
  clearTimer = clearTimeout,
} = {}) {
  if (!pool || typeof pool.connect !== "function") throw new TypeError("pool is required");
  const bootStartedAtMs = nowMs();
  const identity = `${role}:${instance}`;
  let interval = emptyInterval();
  let queuedWaitHistogram = createHistogram();
  let physicalConnectionDurationHistogram = createHistogram();
  let stepIngestion = role === "http" ? emptyStepIngestion() : null;
  let checkedOut = 0;
  let buckets = [];
  let started = false;
  let stopped = false;
  let timer = null;
  let eventLoop = null;
  let previousCpu = process.cpuUsage();
  let previousCpuAtNs = monotonicNowNs();
  let lastProcessSample = { rssBytes: process.memoryUsage().rss, cpuOneCorePercent: 0, eventLoopP99Ms: 0 };
  const warningAt = new Map();
  const originalConnect = pool.connect.bind(pool);

  function warn(reason, fields = {}) {
    const now = nowMs();
    const previous = warningAt.get(reason);
    if (previous != null && now - previous < 60_000) return;
    warningAt.set(reason, now);
    try {
      logger.log(JSON.stringify({
        event: "database_pool_pressure_v1",
        schema: LOG_SCHEMA,
        role,
        instance,
        bootId,
        capturedAtMs: now,
        capturedAt: new Date(now).toISOString(),
        reason,
        ...fields,
      }));
    } catch {}
  }

  function wrapConnect(connect) {
    return function telemetryConnect(callback) {
      const began = monotonicNowNs();
      const max = Number(pool.options?.max) || 20;
      const queued = Number(pool.idleCount) === 0 && Number(pool.totalCount) >= max;
      const physical = Number(pool.idleCount) === 0 && Number(pool.totalCount) < max;
      if (queued) {
        interval.queuedCheckouts += 1;
        warn("waiting_nonzero", { waiting: Math.max(1, Number(pool.waitingCount) || 0) });
      }
      if (physical) interval.physicalAttempts += 1;

      const complete = (error) => {
        const elapsed = monotonicElapsedMs(monotonicNowNs, began);
        if (queued) {
          observeHistogram(queuedWaitHistogram, elapsed);
          recordStepTelemetryPhase("checkout_wait", elapsed);
          if (elapsed > 1000) warn("queued_wait_over_1000ms", { waitMs: elapsed });
          if (error && isPendingCheckoutTimeout(error)) {
            interval.queuedTimeouts += 1;
            warn("queued_checkout_timeout");
          }
        }
        if (physical) {
          observeHistogram(physicalConnectionDurationHistogram, elapsed);
          if (error) {
            if (isPhysicalTimeout(error)) interval.physicalTimeouts += 1;
            else interval.physicalErrors += 1;
            warn("physical_connection_failure", {
              failureKind: isPhysicalTimeout(error) ? "timeout" : "error",
            });
          }
        }
      };

      if (typeof callback === "function") {
        return connect((error, client, release) => {
          complete(error);
          callback(error, client, release);
        });
      }
      return Promise.resolve()
        .then(() => connect())
        .then((client) => {
          complete(null);
          return client;
        }, (error) => {
          complete(error);
          throw error;
        });
    };
  }

  pool.connect = wrapConnect(originalConnect);
  pool.on?.("acquire", () => {
    interval.acquisitions += 1;
    checkedOut += 1;
  });
  pool.on?.("release", () => {
    interval.releases += 1;
    checkedOut = Math.max(0, checkedOut - 1);
  });

  function recordStepRequest(measurement = {}) {
    if (!stepIngestion || !ENDPOINTS.includes(measurement.endpoint) || !OUTCOMES.includes(measurement.outcome)) return false;
    const endpoint = stepIngestion.endpoints.find((row) => row.endpoint === measurement.endpoint);
    for (const target of [stepIngestion, endpoint]) {
      target.requests += 1;
      if (measurement.outcome === "success") target.successes += 1;
      else target.failures += 1;
      if (measurement.outcome === "validation_4xx") target.validation4xx += 1;
      if (measurement.outcome === "auth_4xx") target.auth4xx += 1;
      if (measurement.outcome === "pool_checkout_timeout") {
        target.poolCheckoutTimeouts += 1;
        target.queuedTimeouts += 1;
      }
      if (measurement.outcome === "transaction_error") target.transactionErrors += 1;
      if (measurement.outcome === "server_5xx") target.server5xx += 1;
      observeHistogram(target.requestDurationHistogram, measurement.durationMs);
      observeHistogram(target.authenticationDurationHistogram, measurement.authenticationDurationMs);
      const checkoutDurations = Array.isArray(measurement.checkoutWaitDurationsMs)
        ? measurement.checkoutWaitDurationsMs
        : [measurement.checkoutWaitMs];
      const transactionDurations = Array.isArray(measurement.transactionDurationsMs)
        ? measurement.transactionDurationsMs
        : [measurement.transactionDurationMs];
      for (const duration of checkoutDurations) observeHistogram(target.checkoutWaitHistogram, duration);
      for (const duration of transactionDurations) observeHistogram(target.transactionDurationHistogram, duration);
    }
    return true;
  }

  function recordStepPhase({ phase, durationMs, samplingRate = 1 } = {}) {
    if (!stepIngestion || !PHASES.has(phase)) return false;
    const rate = Number(samplingRate);
    if (!Number.isFinite(rate) || rate < 0 || rate > 1) return false;
    let row = stepIngestion.phases.find((item) => item.phase === phase && item.samplingRate === rate);
    if (!row) {
      row = { phase, observations: 0, samplingRate: rate, histogram: createHistogram() };
      stepIngestion.phases.push(row);
      stepIngestion.phases.sort((left, right) => left.phase.localeCompare(right.phase));
    }
    if (!observeHistogram(row.histogram, durationMs)) return false;
    row.observations = row.histogram.observations;
    return true;
  }

  function processSample() {
    const currentCpu = process.cpuUsage();
    const currentNs = monotonicNowNs();
    const elapsedMicros = Math.max(1, Number(currentNs - previousCpuAtNs) / 1000);
    const cpuMicros = Math.max(0, currentCpu.user - previousCpu.user) + Math.max(0, currentCpu.system - previousCpu.system);
    previousCpu = currentCpu;
    previousCpuAtNs = currentNs;
    lastProcessSample = {
      rssBytes: Math.max(0, process.memoryUsage().rss),
      cpuOneCorePercent: Math.min(100, Math.max(0, (cpuMicros / elapsedMicros) * 100)),
      eventLoopP99Ms: eventLoop ? Math.min(86_400_000, Math.max(0, eventLoop.percentile(99) / 1e6)) : 0,
    };
    eventLoop?.reset();
    return { ...lastProcessSample };
  }

  function currentPool() {
    const max = Number(pool.options?.max) || 20;
    const total = Math.max(0, Number(pool.totalCount) || 0);
    const idle = Math.max(0, Number(pool.idleCount) || 0);
    return {
      max,
      ...(poolConfigSource ? { configSource: poolConfigSource } : {}),
      total,
      idle,
      nonIdle: Math.max(0, total - idle),
      checkedOut: Math.max(0, checkedOut),
      waiting: Math.max(0, Number(pool.waitingCount) || 0),
    };
  }

  function closeMinute(capturedAtMs) {
    const minuteStartedAtMs = Math.floor(capturedAtMs / 60_000) * 60_000 - 60_000;
    const bucket = {
      minuteStartedAtMs,
      minuteStartedAt: new Date(minuteStartedAtMs).toISOString(),
      interval: { ...interval },
      queuedWaitHistogram: cloneHistogram(queuedWaitHistogram),
      physicalConnectionDurationHistogram: cloneHistogram(physicalConnectionDurationHistogram),
      ...(stepIngestion ? { stepIngestion: cloneStepIngestion(stepIngestion) } : {}),
    };
    const existingIndex = buckets.findIndex((item) => item.minuteStartedAtMs === minuteStartedAtMs);
    if (existingIndex >= 0) buckets[existingIndex] = bucket;
    else buckets.push(bucket);
    buckets.sort((left, right) => left.minuteStartedAtMs - right.minuteStartedAtMs);
    buckets = buckets.slice(-60);
    interval = emptyInterval();
    queuedWaitHistogram = createHistogram();
    physicalConnectionDurationHistogram = createHistogram();
    if (stepIngestion) stepIngestion = emptyStepIngestion();
    return bucket;
  }

  function snapshot(capturedAtMs, processMeasurement) {
    let retained = buckets.slice();
    let value;
    do {
      const oldest = retained[0] || null;
      const newest = retained.at(-1) || null;
      value = {
        schema: SNAPSHOT_SCHEMA,
        role,
        instance,
        bootId,
        bootStartedAtMs,
        bootStartedAt: new Date(bootStartedAtMs).toISOString(),
        capturedAtMs,
        capturedAt: new Date(capturedAtMs).toISOString(),
        oldestBucketAt: oldest ? oldest.minuteStartedAt : null,
        newestBucketAt: newest ? newest.minuteStartedAt : null,
        coverageMinutes: retained.length,
        pool: currentPool(),
        process: processMeasurement,
        buckets: retained,
      };
      if (Buffer.byteLength(JSON.stringify(value)) <= SNAPSHOT_SERIALIZED_CAP_BYTES || retained.length === 0) break;
      retained = retained.slice(1);
    } while (true);
    buckets = retained;
    return value;
  }

  function heartbeatFrom(snapshotValue, bucket) {
    const queued = bucket.queuedWaitHistogram;
    const intervalLog = {
      ...bucket.interval,
      ...(queued.observations > 0 ? {
        queuedWaitP95Ms: histogramPercentile(queued, 0.95),
        queuedWaitMaxMs: queued.maxMs,
      } : {}),
    };
    return {
      event: "database_pool_telemetry_v1",
      schema: LOG_SCHEMA,
      role,
      instance,
      bootId,
      bootStartedAtMs,
      bootStartedAt: new Date(bootStartedAtMs).toISOString(),
      capturedAtMs: snapshotValue.capturedAtMs,
      capturedAt: snapshotValue.capturedAt,
      pool: snapshotValue.pool,
      interval: intervalLog,
      process: snapshotValue.process,
      ...(bucket.stepIngestion ? { stepIngestion: bucket.stepIngestion } : {}),
    };
  }

  function minuteEmission(bucket) {
    if (!bucket.stepIngestion) return null;
    const endpoints = {};
    for (const row of bucket.stepIngestion.endpoints) {
      endpoints[row.endpoint] = {
        requests: row.requests,
        successes: row.successes,
        validation4xx: row.validation4xx,
        auth4xx: row.auth4xx,
        poolCheckoutTimeouts: row.poolCheckoutTimeouts,
        transactionErrors: row.transactionErrors,
        server5xx: row.server5xx,
      };
    }
    return { minuteStartedAtMs: bucket.minuteStartedAtMs, role, instance, bootId, endpoints };
  }

  async function flush(capturedAtMs = nowMs()) {
    const bucket = closeMinute(capturedAtMs);
    const value = snapshot(capturedAtMs, processSample());
    try { logger.log(JSON.stringify(heartbeatFrom(value, bucket))); } catch {}
    if (redisCache && cacheKeys && SUPPORTED_IDENTITIES.has(identity)) {
      const writes = [redisCache.writeDatabasePoolTelemetrySnapshot(
        cacheKeys.databasePoolTelemetry(role, instance),
        value,
        SNAPSHOT_TTL_SECONDS,
      )];
      const emission = minuteEmission(bucket);
      if (emission) {
        writes.push(redisCache.writeStepIngestionMinute({
          hourKey: cacheKeys.stepIngestionHour(bucket.minuteStartedAtMs),
          startKey: cacheKeys.stepIngestionHistoryStart(),
          emission,
          collectionStartedMinuteMs: Math.floor(bootStartedAtMs / 60_000) * 60_000,
          ttlSeconds: HISTORY_TTL_SECONDS,
        }));
      }
      await Promise.allSettled(writes);
    }
    return value;
  }

  function armBoundary(targetBoundaryMs) {
    if (!started || stopped) return;
    const delay = Math.max(1, targetBoundaryMs - nowMs());
    timer = setTimer(async () => {
      timer = null;
      if (!started || stopped) return;
      const observedAtMs = nowMs();
      if (observedAtMs < targetBoundaryMs) {
        armBoundary(targetBoundaryMs);
        return;
      }
      try { await flush(observedAtMs); } catch {}
      if (!started || stopped) return;
      const afterFlushMs = nowMs();
      const nextBoundaryMs = Math.max(
        targetBoundaryMs + 60_000,
        Math.floor(observedAtMs / 60_000) * 60_000 + 60_000,
        Math.floor(afterFlushMs / 60_000) * 60_000 + 60_000,
      );
      armBoundary(nextBoundaryMs);
    }, delay);
    timer?.unref?.();
  }

  function scheduleNext() {
    const observedAtMs = nowMs();
    const targetBoundaryMs = Math.floor(observedAtMs / 60_000) * 60_000 + 60_000;
    armBoundary(targetBoundaryMs);
  }

  function start() {
    if (started || stopped) return { stop };
    if (!SUPPORTED_IDENTITIES.has(identity)) return { stop };
    started = true;
    eventLoop = monitorEventLoopDelay({ resolution: 10 });
    eventLoop.enable();
    scheduleNext();
    return { stop };
  }

  function stop() {
    if (stopped) return;
    stopped = true;
    if (timer) clearTimer(timer);
    eventLoop?.disable();
  }

  function captureForTest(capturedAtMs = nowMs()) {
    const bucket = closeMinute(capturedAtMs);
    void bucket;
    return snapshot(capturedAtMs, { ...lastProcessSample });
  }

  return {
    role,
    instance,
    bootId,
    start,
    stop,
    flush,
    recordStepRequest,
    recordStepPhase,
    captureForTest,
    wrapConnectForTest: wrapConnect,
  };
}

module.exports = {
  HISTOGRAM_BOUNDARIES_MS,
  ENDPOINTS,
  OUTCOMES,
  PHASES,
  createHistogram,
  observeHistogram,
  mergeHistograms,
  histogramPercentile,
  createDatabasePoolTelemetry,
  isPendingCheckoutTimeout,
};
