const crypto = require("node:crypto");

const PROFILE_NAMES = Object.freeze([
  "idle-baseline", "ordinary-sync", "eligible-nonoverlap", "eligible-overlap",
  "android-periodic", "android-synchronized", "android-jittered",
  "foreground-five-minute", "expedited-over-periodic", "mixed-production",
  "event-end-worst-case", "drain",
]);

const DEFAULT_GLOBAL_EVENT_SYNC_CONFIG = Object.freeze({
  schema: "global-event-step-sync-config-v1",
  version: "1.0.0",
  topology: Object.freeze({ httpWorkers: 2, resolutionWorkers: 1, cronWorkers: 1,
    pools: Object.freeze({ http0: 10, http1: 10, resolution: 8, cron: 4 }) }),
  users: 100,
  controlUsers: 10,
  arrivalRate: 5,
  duration: "30s",
  warmupSeconds: 15,
  jitterMs: 0,
  eligibleSummaryCount: 90,
  participantsPerRace: 50,
  raceSizes: null,
  racesPerUser: 2,
  overlap: 0.5,
  samplesPerParticipant: 12,
  sampleHistoryMinutes: 180,
  powerupEventDensity: 0.1,
  sampleSteps: 100,
  maxUsers: 5000,
  maxDurationSeconds: 900,
  maxArrivalRate: 500,
  sampleMaxPerParticipant: 288,
  externalDelivery: "disabled",
});

function parseBoolean(value, name) {
  if (value === true || value === false) return value;
  if (value === 1 || value === "1" || String(value).toLowerCase() === "true") return true;
  if (value === 0 || value === "0" || String(value).toLowerCase() === "false") return false;
  throw new Error(`${name} must be a boolean`);
}

function parseDurationSeconds(value) {
  if (Number.isFinite(Number(value))) return Number(value);
  const match = String(value || "").trim().match(/^(\d+(?:\.\d+)?)(s|m|h)$/i);
  if (!match) throw new Error("duration must be seconds or a value like 30s");
  const multiplier = { s: 1, m: 60, h: 3600 }[match[2].toLowerCase()];
  return Number(match[1]) * multiplier;
}

function normalizeGlobalEventSyncConfig(input = {}) {
  const config = { ...DEFAULT_GLOBAL_EVENT_SYNC_CONFIG, ...input };
  if (input.controlUsers === undefined) config.controlUsers = Math.min(10, Math.max(1, Number(config.users) - 1));
  if (!PROFILE_NAMES.includes(config.profile || "ordinary-sync")) throw new Error("unknown global-event sync profile");
  const integer = (name, minimum, maximum) => {
    const value = Number(config[name]);
    if (!Number.isInteger(value) || value < minimum || value > maximum) throw new Error(`${name} is outside configured budget`);
    return value;
  };
  config.users = integer("users", 1, DEFAULT_GLOBAL_EVENT_SYNC_CONFIG.maxUsers);
  config.controlUsers = integer("controlUsers", 1, Math.max(1, config.users - 1));
  config.arrivalRate = integer("arrivalRate", 0, DEFAULT_GLOBAL_EVENT_SYNC_CONFIG.maxArrivalRate);
  config.durationSeconds = parseDurationSeconds(config.duration);
  if (config.durationSeconds < 0 || config.durationSeconds > DEFAULT_GLOBAL_EVENT_SYNC_CONFIG.maxDurationSeconds) throw new Error("duration is outside configured budget");
  config.participantsPerRace = integer("participantsPerRace", 1, 500);
  if (config.raceSizes != null) {
    if (!Array.isArray(config.raceSizes) || config.raceSizes.length < 1 || config.raceSizes.length > 20 || config.raceSizes.some((value) => !Number.isInteger(Number(value)) || Number(value) < 1 || Number(value) > 500)) throw new Error("raceSizes is outside configured budget");
    config.raceSizes = Object.freeze(config.raceSizes.map(Number));
  }
  config.racesPerUser = integer("racesPerUser", 1, 20);
  config.eligibleSummaryCount = integer("eligibleSummaryCount", 0, 10000);
  if (config.eligibleSummaryCount > config.users - config.controlUsers) throw new Error("eligibleSummaryCount must leave the configured control cohort");
  config.samplesPerParticipant = integer("samplesPerParticipant", 1, config.sampleMaxPerParticipant);
  config.sampleHistoryMinutes = integer("sampleHistoryMinutes", 1, 24 * 60);
  config.jitterMs = integer("jitterMs", 0, 60_000);
  config.powerupEventDensity = Number(config.powerupEventDensity);
  if (!Number.isFinite(config.powerupEventDensity) || config.powerupEventDensity < 0 || config.powerupEventDensity > 1) throw new Error("powerupEventDensity must be between 0 and 1");
  config.overlap = Number(config.overlap);
  if (!Number.isFinite(config.overlap) || config.overlap < 0 || config.overlap > 1) throw new Error("overlap must be between 0 and 1");
  if (config.participantsPerRace > config.users) throw new Error("participantsPerRace cannot exceed users without an expanded fixture user budget");
  if (config.externalDelivery !== "disabled") throw new Error("externalDelivery must be disabled for the global-event sync harness");
  config.capacityMetricsEnabled = input.capacityMetricsEnabled === undefined
    ? true : parseBoolean(input.capacityMetricsEnabled, "capacityMetricsEnabled");
  return Object.freeze(config);
}

function seededRandom(seed) {
  let state = crypto.createHash("sha256").update(String(seed)).digest().readUInt32LE(0);
  return () => { state = (Math.imul(1664525, state) + 1013904223) >>> 0; return state / 0x1_0000_0000; };
}

function buildArrivalPlan({ rate, durationSeconds, mode = "synchronized", jitterMs = 0, seed = "global-event" } = {}) {
  const count = Number(rate) * Number(durationSeconds);
  if (!Number.isInteger(count) || count < 0) throw new Error("arrival rate and duration must produce a finite whole request count");
  const random = seededRandom(seed);
  const plan = [];
  for (let second = 0; second < Number(durationSeconds); second += 1) {
    for (let slot = 0; slot < Number(rate); slot += 1) {
      const offset = mode === "jittered" ? Math.round((random() * 2 - 1) * Number(jitterMs)) :
        mode === "periodic" ? Math.round((slot / Math.max(1, Number(rate))) * 1000) : 0;
      plan.push({ sequence: plan.length, second, atMs: Math.max(0, second * 1000 + offset) });
    }
  }
  return plan;
}

function buildIdempotencyKey({ runId, repeat = 1, userId, iteration = 0 } = {}) {
  const hex = crypto.createHash("sha256").update(`${runId}:${repeat}:${userId}:${iteration}`).digest("hex").slice(0, 32);
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-4${hex.slice(13, 16)}-8${hex.slice(17, 20)}-${hex.slice(20)}`;
}

function buildSyncBody({ date, steps = 1000, sampleCount = 12, seed = "global-event", now = new Date(`${date}T12:00:00.000Z`) } = {}) {
  if (!Number.isInteger(Number(sampleCount)) || sampleCount < 0 || sampleCount > 96) throw new Error("samples count must be between 0 and 96");
  if (!/^\d{4}-\d{2}-\d{2}$/.test(String(date || ""))) throw new Error("date must be YYYY-MM-DD");
  const start = new Date(now).getTime() - Number(sampleCount) * 15 * 60_000;
  return { date, steps: Math.max(0, Math.floor(Number(steps))), samples: Array.from({ length: Number(sampleCount) }, (_, index) => ({
    periodStart: new Date(start + index * 15 * 60_000).toISOString(),
    periodEnd: new Date(start + (index + 1) * 15 * 60_000).toISOString(),
    steps: Math.max(0, Math.floor(Number(steps) / Math.max(1, Number(sampleCount)))),
    sourceName: "capacity-global-event",
    sourceId: `${seed}:${index}`,
    recordingMethod: "automatic",
  })) };
}

module.exports = { DEFAULT_GLOBAL_EVENT_SYNC_CONFIG, PROFILE_NAMES, buildArrivalPlan,
  buildIdempotencyKey, buildSyncBody, normalizeGlobalEventSyncConfig, parseBoolean };
