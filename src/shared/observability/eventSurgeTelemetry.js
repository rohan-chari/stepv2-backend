const redisCacheDefault = require("../cache/redisCache");
const cacheKeysDefault = require("../cache/cacheKeys");

const SNAPSHOT_TTL_SECONDS = 150;
const MAX_SAMPLES_PER_MINUTE = 10_000;
const ENDPOINT_CLASSES = new Set(["interactive", "step-intake", "other"]);

function percentile(values, proportion) {
  if (!values.length) return null;
  const sorted = [...values].sort((left, right) => left - right);
  return sorted[Math.max(0, Math.ceil(sorted.length * proportion) - 1)];
}

function durations(values) {
  return {
    p50: percentile(values, 0.50),
    p95: percentile(values, 0.95),
    p99: percentile(values, 0.99),
  };
}

function endpointBucket() {
  return { requests: 0, successes: 0, client4xx: 0, server5xx: 0, durationsMs: [] };
}

function stateForMinute() {
  return {
    http: {
      interactive: endpointBucket(), stepIntake: endpointBucket(), other: endpointBucket(),
      fanout: new Map(),
    },
    stepAdmission: {
      admitted: 0, rejected: 0, succeeded: 0, failed: 0,
      activeMax: 0, queuedMax: 0, waitsMs: [],
    },
    notification: {
      eventId: null, eligible: 0, schedulesPending: 0, materialized: 0,
      expired: 0, canceled: 0, providerClaimed: 0, lagsMs: [],
    },
    resolution: { oldestAgeMs: 0 },
    home: { phases: new Map() },
  };
}

function boundedPush(values, value) {
  const number = Number(value);
  if (Number.isFinite(number) && number >= 0 && values.length < MAX_SAMPLES_PER_MINUTE) values.push(number);
}

function createEventSurgeTelemetry({
  role = process.env.STEPS_PROCESS_ROLE || "all",
  instance = process.env.NODE_APP_INSTANCE == null ? "0" : String(process.env.NODE_APP_INSTANCE),
  nowMs = Date.now,
  logger = console,
  redisCache = redisCacheDefault,
  cacheKeys = cacheKeysDefault,
  getDbPoolPressure = null,
  setTimer = setTimeout,
  clearTimer = clearTimeout,
} = {}) {
  let state = stateForMinute();
  let timer = null;
  let stopped = false;

  function recordHttpRequest({ endpointClass = "other", path = "unknown", status = 0, durationMs = 0 } = {}) {
    const normalized = ENDPOINT_CLASSES.has(endpointClass) ? endpointClass : "other";
    const key = normalized === "step-intake" ? "stepIntake" : normalized;
    const bucket = state.http[key];
    bucket.requests += 1;
    if (status >= 200 && status < 400) bucket.successes += 1;
    else if (status >= 400 && status < 500) bucket.client4xx += 1;
    else if (status >= 500) bucket.server5xx += 1;
    boundedPush(bucket.durationsMs, durationMs);
    const safePath = String(path || "unknown").slice(0, 96);
    state.http.fanout.set(safePath, Math.min(1_000_000, (state.http.fanout.get(safePath) || 0) + 1));
  }

  function recordStepAdmission({ outcome, waitMs = 0, active = 0, queued = 0 } = {}) {
    if (["admitted", "rejected", "succeeded", "failed"].includes(outcome)) state.stepAdmission[outcome] += 1;
    state.stepAdmission.activeMax = Math.max(state.stepAdmission.activeMax, Number(active) || 0);
    state.stepAdmission.queuedMax = Math.max(state.stepAdmission.queuedMax, Number(queued) || 0);
    boundedPush(state.stepAdmission.waitsMs, waitMs);
  }

  function recordNotification(measurement = {}) {
    if (typeof measurement.eventId === "string") state.notification.eventId = measurement.eventId.slice(0, 128);
    for (const key of ["eligible", "schedulesPending", "materialized", "expired", "canceled", "providerClaimed"]) {
      if (Number.isFinite(Number(measurement[key]))) state.notification[key] += Math.max(0, Number(measurement[key]));
    }
    if (measurement.lagMs != null) boundedPush(state.notification.lagsMs, measurement.lagMs);
  }

  function recordResolutionLag({ oldestAgeMs = 0 } = {}) {
    state.resolution.oldestAgeMs = Math.max(state.resolution.oldestAgeMs, Number(oldestAgeMs) || 0);
  }

  function recordHomePhase({ phase, durationMs = 0 } = {}) {
    const safePhase = String(phase || "unknown").slice(0, 48);
    let bucket = state.home.phases.get(safePhase);
    if (!bucket) {
      bucket = { requests: 0, durationsMs: [] };
      state.home.phases.set(safePhase, bucket);
    }
    bucket.requests += 1;
    boundedPush(bucket.durationsMs, durationMs);
  }

  function snapshot(capturedAtMs) {
    const serializeEndpoint = (bucket) => ({
      requests: bucket.requests, successes: bucket.successes,
      client4xx: bucket.client4xx, server5xx: bucket.server5xx,
      latencyMs: durations(bucket.durationsMs),
    });
    let pool = null;
    try { pool = getDbPoolPressure?.() || null; } catch {}
    return {
      event: "event_surge_v1", schema: "event_surge_v1", role, instance,
      minuteStartedAt: new Date(Math.floor(capturedAtMs / 60_000) * 60_000 - 60_000).toISOString(),
      capturedAt: new Date(capturedAtMs).toISOString(),
      http: {
        interactive: serializeEndpoint(state.http.interactive),
        stepIntake: serializeEndpoint(state.http.stepIntake),
        other: serializeEndpoint(state.http.other),
        endpointFanout: Object.fromEntries([...state.http.fanout.entries()].sort()),
      },
      stepAdmission: {
        admitted: state.stepAdmission.admitted, rejected: state.stepAdmission.rejected,
        succeeded: state.stepAdmission.succeeded, failed: state.stepAdmission.failed,
        activeMax: state.stepAdmission.activeMax, queuedMax: state.stepAdmission.queuedMax,
        waitMs: durations(state.stepAdmission.waitsMs),
      },
      notification: {
        eventId: state.notification.eventId, eligible: state.notification.eligible,
        schedulesPending: state.notification.schedulesPending,
        materialized: state.notification.materialized, expired: state.notification.expired,
        canceled: state.notification.canceled,
        providerClaimed: state.notification.providerClaimed,
        lagMs: durations(state.notification.lagsMs),
      },
      resolution: { ...state.resolution }, pool,
      home: {
        phases: Object.fromEntries([...state.home.phases.entries()]
          .sort(([left], [right]) => left.localeCompare(right))
          .map(([phase, bucket]) => [phase, {
            requests: bucket.requests,
            latencyMs: durations(bucket.durationsMs),
          }])),
      },
    };
  }

  async function flush(capturedAtMs = nowMs()) {
    const value = snapshot(capturedAtMs);
    state = stateForMinute();
    try { logger.log(JSON.stringify(value)); } catch {}
    try { await redisCache?.setJSON?.(cacheKeys.eventSurge(role, instance), value, SNAPSHOT_TTL_SECONDS); } catch {}
    return value;
  }

  function arm() {
    if (stopped) return;
    const current = nowMs();
    const boundary = Math.floor(current / 60_000) * 60_000 + 60_000;
    timer = setTimer(async () => {
      timer = null;
      if (stopped) return;
      await flush(nowMs());
      arm();
    }, Math.max(1, boundary - current));
    timer?.unref?.();
  }

  function start() { if (!timer && !stopped) arm(); return { stop }; }
  function stop() { stopped = true; if (timer) clearTimer(timer); timer = null; }

  function middleware() {
    return (req, res, next) => {
      const started = process.hrtime.bigint();
      res.once("finish", () => {
        const requestPath = req.originalUrl?.split("?")[0] || req.path;
        const step = req.method === "POST" && ["/steps", "/steps/samples", "/steps/sync-v2"].includes(requestPath);
        const interactive = ["/auth/me", "/home/race-card", "/races", "/races/discovery-summary", "/inbox/alerts"].includes(requestPath) || /^\/races\/[^/]+\/(?:progress|bootstrap)$/.test(requestPath);
        recordHttpRequest({
          endpointClass: step ? "step-intake" : interactive ? "interactive" : "other",
          path: `${req.method} ${requestPath}`, status: res.statusCode,
          durationMs: Number(process.hrtime.bigint() - started) / 1e6,
        });
      });
      next();
    };
  }

  return { start, stop, flush, middleware, recordHttpRequest, recordStepAdmission, recordNotification, recordResolutionLag, recordHomePhase };
}

const eventSurgeTelemetry = createEventSurgeTelemetry({
  getDbPoolPressure: () => require("../../db").getDbPoolPressure(),
});

module.exports = { SNAPSHOT_TTL_SECONDS, createEventSurgeTelemetry, eventSurgeTelemetry };
