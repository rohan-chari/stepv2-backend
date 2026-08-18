const { AsyncLocalStorage } = require("node:async_hooks");
const {
  currentRequestQueryCount,
  runWithRequestQueryCounter,
  runWithPhaseQueryCounter,
} = require("../http/requestQueryCounter");

const FLAG = "capacityPhaseMetricsV1Enabled";
const EVENT = "capacity_phase_metrics_v1";
const LOG_MESSAGE = "[CAPACITY] phase metrics v1";
const DEFAULT_SAMPLE_RATE = 0.1;
const QUERY_CAPTURE_ENABLED_SETTING = "PRISMA_QUERY_EVENTS_ENABLED=true";
const QUERY_CAPTURE_DISABLED_SETTING = "PRISMA_QUERY_EVENTS_ENABLED!=true";

const storage = new AsyncLocalStorage();

function isValidCapacityRunId(value) {
  return typeof value === "string" &&
    /^[a-z0-9][a-z0-9._-]{0,63}$/i.test(value);
}

function isValidCapacityRepeat(value) {
  return typeof value === "string" && /^[123]$/.test(value);
}

function capacityRequestDimensions(req) {
  const runId = req?.headers?.["x-capacity-run-id"];
  const repeat = req?.headers?.["x-capacity-repeat"];
  return {
    ...(isValidCapacityRunId(runId) ? { runId } : {}),
    ...(isValidCapacityRepeat(repeat) ? { repeat } : {}),
  };
}

function sampleRate(env = process.env) {
  const parsed = Number(env.CAPACITY_PHASE_METRICS_SAMPLE_RATE);
  if (!Number.isFinite(parsed)) return DEFAULT_SAMPLE_RATE;
  return Math.min(1, Math.max(0, parsed));
}

function shouldSample({ random = Math.random, env = process.env } = {}) {
  return random() < sampleRate(env);
}

function monotonicNow() {
  return process.hrtime.bigint();
}

function elapsedMs(startedAt) {
  return Number(process.hrtime.bigint() - startedAt) / 1e6;
}

function safePoolPressure(readPressure) {
  try {
    const value = readPressure?.() || {};
    return {
      total: Math.max(0, Number(value.total) || 0),
      idle: Math.max(0, Number(value.idle) || 0),
      waiting: Math.max(0, Number(value.waiting) || 0),
    };
  } catch {
    return { total: 0, idle: 0, waiting: 0 };
  }
}

function sensitiveMetricKey(key) {
  const normalized = String(key || "").toLowerCase();
  return normalized.includes("token") ||
    normalized.includes("body") ||
    normalized.includes("bodies") ||
    normalized.includes("source") ||
    normalized.includes("raw") ||
    /(?:user|participant|race|message)(?:id|ids)$/.test(normalized);
}

function sanitizeCounts(counts) {
  const out = {};
  for (const [key, value] of Object.entries(counts || {})) {
    // Metrics are aggregate-only. Reject likely identity/payload fields at the
    // common seam so a future caller cannot accidentally put personal material
    // into a capacity line.
    if (sensitiveMetricKey(key)) continue;
    const numeric = Number(value);
    if (Number.isFinite(numeric)) out[key] = Math.max(0, numeric);
  }
  return out;
}

function sanitizeDimensions(dimensions) {
  const out = {};
  for (const [key, value] of Object.entries(dimensions || {})) {
    if (sensitiveMetricKey(key)) continue;
    if (typeof value === "boolean") out[key] = value;
    else if (typeof value === "string" && value.length <= 64) out[key] = value;
  }
  return out;
}

function inactiveSpan() {
  return {
    active: false,
    startPhase() { return () => {}; },
    async measurePhase(_name, operation) { return operation(); },
    recordPhases() {},
    setCounts() {},
    setDimensions() {},
    finish() {},
  };
}

function startCapacityPhase(surface) {
  const context = storage.getStore();
  if (!context?.sampled || typeof surface !== "string" || !surface) {
    return inactiveSpan();
  }

  const startedAt = monotonicNow();
  const cpuStart = process.cpuUsage();
  const phaseMs = {};
  const phaseQueryCount = {};
  let counts = {};
  let dimensions = sanitizeDimensions(context.entryDimensions);
  let finished = false;

  function startPhase(name) {
    if (finished || typeof name !== "string" || !name) return () => {};
    const phaseStartedAt = monotonicNow();
    let ended = false;
    return () => {
      if (ended || finished) return;
      ended = true;
      phaseMs[name] = (phaseMs[name] || 0) + elapsedMs(phaseStartedAt);
    };
  }

  return {
    active: true,
    startPhase,
    async measurePhase(name, operation) {
      const phaseStartedAt = monotonicNow();
      const queryContext = { count: 0 };
      try {
        return context.queryCaptureAvailable
          ? await runWithPhaseQueryCounter(queryContext, operation)
          : await operation();
      } finally {
        phaseMs[name] = (phaseMs[name] || 0) + elapsedMs(phaseStartedAt);
        if (context.queryCaptureAvailable) {
          phaseQueryCount[name] =
            (phaseQueryCount[name] || 0) + queryContext.count;
        }
      }
    },
    recordPhases(durations, queryCounts = null) {
      for (const [name, value] of Object.entries(durations || {})) {
        const numeric = Number(value);
        if (Number.isFinite(numeric)) phaseMs[name] = Math.max(0, numeric);
      }
      for (const [name, value] of Object.entries(
        context.queryCaptureAvailable ? queryCounts || {} : {},
      )) {
        const numeric = Number(value);
        if (Number.isFinite(numeric)) {
          phaseQueryCount[name] = Math.max(0, Math.trunc(numeric));
        }
      }
    },
    setCounts(next) { counts = { ...counts, ...sanitizeCounts(next) }; },
    setDimensions(next) {
      dimensions = { ...dimensions, ...sanitizeDimensions(next) };
    },
    finish(outcome = "success") {
      if (finished) return;
      finished = true;
      const cpu = process.cpuUsage(cpuStart);
      const memory = process.memoryUsage();
      const queryCount = Object.values(phaseQueryCount).reduce(
        (total, value) => total + value,
        0,
      );
      const fields = {
        event: EVENT,
        surface,
        sampled: true,
        sampleRate: context.sampleRate,
        queryCaptureAvailable: context.queryCaptureAvailable,
        queryCaptureSetting: context.queryCaptureAvailable
          ? QUERY_CAPTURE_ENABLED_SETTING
          : QUERY_CAPTURE_DISABLED_SETTING,
        // Any paired benchmark containing `false` here is non-claimable. This
        // deliberately fails closed rather than presenting zeroes as query data.
        measurementGateEligible: context.queryCaptureAvailable,
        outcome:
          typeof outcome === "string" && outcome.length <= 64
            ? outcome
            : "unknown",
        durationMs: Math.max(0, elapsedMs(startedAt)),
        ...(context.queryCaptureAvailable ? { queryCount } : {}),
        phaseMs,
        ...(context.queryCaptureAvailable ? { phaseQueryCount } : {}),
        counts,
        dimensions,
        processPressure: {
          rssBytes: memory.rss,
          heapUsedBytes: memory.heapUsed,
          cpuUserMicros: Math.max(0, cpu.user),
          cpuSystemMicros: Math.max(0, cpu.system),
        },
        dbPoolPressure: safePoolPressure(context.readDbPoolPressure),
      };
      if (context.logger === console) {
        // PM2 captures console stdout verbatim. One pre-serialized argument is
        // required here: `console.log(message, object)` invokes Node's
        // multi-line inspect formatter and cannot be consumed as NDJSON.
        context.logger.log(JSON.stringify({ message: LOG_MESSAGE, ...fields }));
      } else {
        context.logger.log?.(LOG_MESSAGE, fields);
      }
    },
  };
}

function runInContext(context, callback) {
  const run = () => storage.run(context, callback);
  return currentRequestQueryCount() == null
    ? runWithRequestQueryCounter(run)
    : run();
}

async function runCapacityMetricsEntry({
  settings,
  logger = console,
  random = Math.random,
  env = process.env,
  readDbPoolPressure = null,
  forceSample = false,
  queryCaptureAvailable =
    process.env.PRISMA_QUERY_EVENTS_ENABLED === "true",
  entryDimensions = null,
} = {}, callback) {
  let enabled = false;
  try {
    enabled = (await settings?.getFlag?.(FLAG)) === true;
  } catch {
    enabled = false;
  }
  if (!enabled) return callback();

  const rate = sampleRate(env);
  const sampled = forceSample || random() < rate;
  return runInContext(
    {
      sampled,
      sampleRate: forceSample ? 1 : rate,
      logger,
      readDbPoolPressure,
      queryCaptureAvailable: queryCaptureAvailable === true,
      entryDimensions: sanitizeDimensions(entryDimensions),
    },
    callback,
  );
}

function createCapacityPhaseMetricsMiddleware(dependencies = {}) {
  return function capacityPhaseMetrics(req, res, next) {
    return runCapacityMetricsEntry(
      {
        ...dependencies,
        entryDimensions: capacityRequestDimensions(req),
      },
      next,
    ).catch(next);
  };
}

module.exports = {
  DEFAULT_SAMPLE_RATE,
  EVENT,
  FLAG,
  LOG_MESSAGE,
  QUERY_CAPTURE_DISABLED_SETTING,
  QUERY_CAPTURE_ENABLED_SETTING,
  capacityRequestDimensions,
  createCapacityPhaseMetricsMiddleware,
  runCapacityMetricsEntry,
  sampleRate,
  shouldSample,
  isValidCapacityRepeat,
  isValidCapacityRunId,
  startCapacityPhase,
};
