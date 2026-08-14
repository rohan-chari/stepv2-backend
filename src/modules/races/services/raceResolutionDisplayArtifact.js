const crypto = require("node:crypto");
const defaultRedisCache = require("../../../shared/cache/redisCache");
const { raceResolutionArtifact } = require("../../../shared/cache/cacheKeys");
const {
  getTimeZoneParts,
  formatDateString,
  addDaysToDateString,
  parseDateString,
  zonedDateTimeToUtc,
} = require("../../../shared/time/week");
const {
  POWERUP_SCOPE_BY_TYPE,
} = require("./raceResolutionReasonRegistry");

const ARTIFACT_SCHEMA = 1;
const ARTIFACT_TTL_SECONDS = 120;
const ARTIFACT_MAX_BYTES = 1024 * 1024;
const ARTIFACT_MAX_PARTICIPANTS = 1000;

function stableJson(value) {
  if (Array.isArray(value)) return `[${value.map(stableJson).join(",")}]`;
  if (value instanceof Date) return JSON.stringify(value.toISOString());
  if (value && typeof value === "object") {
    return `{${Object.keys(value)
      .sort()
      .map((key) => `${JSON.stringify(key)}:${stableJson(value[key])}`)
      .join(",")}}`;
  }
  return JSON.stringify(value);
}

function digestPayload(payload) {
  return crypto.createHash("sha256").update(stableJson(payload)).digest("hex");
}

function computeArtifactReuseDeadline({
  asOf,
  timeZone,
  raceEndsAt = null,
  nextSampleBoundary = null,
  activeEffects = [],
  globalEvents = [],
} = {}) {
  const start = new Date(asOf || 0);
  if (Number.isNaN(start.getTime()) || typeof timeZone !== "string") return null;
  const candidates = [start.getTime() + 5_000];
  const addBoundary = (value) => {
    if (!value) return;
    const ms = new Date(value).getTime();
    if (!Number.isFinite(ms) || ms <= start.getTime()) return;
    candidates.push(ms);
  };
  if (raceEndsAt && new Date(raceEndsAt).getTime() <= start.getTime()) return null;
  addBoundary(raceEndsAt);
  addBoundary(nextSampleBoundary);
  for (const effect of activeEffects || []) {
    if (!effect?.type || !POWERUP_SCOPE_BY_TYPE[effect.type]) return null;
    addBoundary(effect.startsAt);
    addBoundary(effect.expiresAt);
  }
  for (const event of globalEvents || []) {
    addBoundary(event.startsAt);
    addBoundary(event.endsAt);
  }
  // Legacy Hitchhike changes its bucket at every absolute top of hour.
  candidates.push(
    Date.UTC(
      start.getUTCFullYear(),
      start.getUTCMonth(),
      start.getUTCDate(),
      start.getUTCHours() + 1,
      0,
      0,
      0
    )
  );
  try {
    const parts = getTimeZoneParts(start, timeZone);
    const today = formatDateString(parts.year, parts.month, parts.day);
    const tomorrow = parseDateString(addDaysToDateString(today, 1));
    candidates.push(zonedDateTimeToUtc({
      year: tomorrow.year,
      month: tomorrow.month,
      day: tomorrow.day,
      hour: 0,
      minute: 0,
      second: 0,
    }, timeZone).getTime());
  } catch {
    return null;
  }
  return new Date(Math.min(...candidates));
}

function artifactMatchesClaim(payload, job) {
  if (!payload || !job || payload.raceId !== job.raceId) return false;
  if (payload.timeZone !== (job.processingTimeZone || "UTC")) return false;
  if (
    !Array.isArray(job.processingDirtyReasons) ||
    job.processingDirtyReasons.length !== 1 ||
    job.processingDirtyReasons[0] !== "DISPLAY_REFRESH"
  ) return false;
  const payloadTriggers = Array.isArray(payload.triggeringUserIds)
    ? [...new Set(payload.triggeringUserIds)].sort()
    : null;
  const jobTriggers = Array.isArray(job.processingTriggeredByUserIds)
    ? [...new Set(job.processingTriggeredByUserIds)].sort()
    : null;
  if (!payloadTriggers || !jobTriggers) return false;
  if (JSON.stringify(payloadTriggers) !== JSON.stringify(jobTriggers)) return false;
  if (!/^[a-f0-9]{64}$/i.test(payload.inputFingerprint || "")) return false;
  if (!Array.isArray(payload.writes) || !payload.result?.race) return false;
  return payload.writes.every((write) => {
    if (write?.kind === "participantTotal") {
      return typeof write.participantId === "string" &&
        Number.isFinite(write.totalSteps) &&
        (write.rawSteps == null || Number.isFinite(write.rawSteps));
    }
    if (write?.kind === "participantBonus") {
      return typeof write.participantId === "string" &&
        Number.isFinite(write.amount) && write.amount >= 0;
    }
    if (write?.kind === "effectUpdate") {
      return typeof write.id === "string" &&
        write.fields && typeof write.fields === "object" &&
        !Array.isArray(write.fields) &&
        Object.keys(write.fields).every((key) => key === "status");
    }
    if (write?.kind === "eventCreate") {
      const data = write.data;
      return data?.powerupType === "TRAIL_MINE" &&
        typeof data.raceId === "string" &&
        typeof data.targetUserId === "string" &&
        data.metadata && typeof data.metadata === "object";
    }
    return false;
  });
}

function buildRaceResolutionDisplayArtifactStore(dependencies = {}) {
  const redisCache = dependencies.redisCache || defaultRedisCache;
  const randomId = dependencies.randomId || (() => crypto.randomUUID());
  const now = dependencies.now || (() => new Date());

  return {
    async put(payload) {
      if (!payload || typeof payload !== "object" || Array.isArray(payload)) return null;
      if (payload.unknownBoundary === true) return null;
      if (!Array.isArray(payload.participants)) return null;
      if (payload.participants.length > ARTIFACT_MAX_PARTICIPANTS) return null;
      if (typeof payload.raceId !== "string" || payload.raceId.length === 0) return null;
      const reuseDeadline = new Date(payload.reuseDeadline || 0);
      if (Number.isNaN(reuseDeadline.getTime())) return null;
      const encoded = stableJson(payload);
      if (Buffer.byteLength(encoded, "utf8") > ARTIFACT_MAX_BYTES) return null;
      const digest = digestPayload(payload);
      const id = randomId();
      let key;
      try {
        key = raceResolutionArtifact(id);
      } catch {
        return null;
      }
      const stored = await redisCache.setJSON(
        key,
        { schema: ARTIFACT_SCHEMA, digest, payload },
        ARTIFACT_TTL_SECONDS
      );
      return stored ? { id, digest, schema: ARTIFACT_SCHEMA } : null;
    },

    async load({ id, digest, schema, raceId, timeZone }) {
      if (schema !== ARTIFACT_SCHEMA || !/^[a-f0-9]{64}$/.test(digest || "")) {
        return null;
      }
      let envelope;
      try {
        envelope = await redisCache.getJSON(raceResolutionArtifact(id));
      } catch {
        return null;
      }
      const payload = envelope?.payload;
      if (
        envelope?.schema !== ARTIFACT_SCHEMA ||
        envelope?.digest !== digest ||
        !payload ||
        digestPayload(payload) !== digest ||
        payload.raceId !== raceId ||
        payload.timeZone !== timeZone ||
        !Array.isArray(payload.participants) ||
        payload.participants.length > ARTIFACT_MAX_PARTICIPANTS ||
        new Date(payload.reuseDeadline || 0).getTime() <= now().getTime()
      ) {
        return null;
      }
      return payload;
    },

    async consume(id) {
      try {
        return await redisCache.del(raceResolutionArtifact(id));
      } catch {
        return false;
      }
    },
  };
}

const raceResolutionDisplayArtifact = buildRaceResolutionDisplayArtifactStore();

module.exports = {
  ARTIFACT_SCHEMA,
  ARTIFACT_TTL_SECONDS,
  ARTIFACT_MAX_BYTES,
  ARTIFACT_MAX_PARTICIPANTS,
  digestPayload,
  computeArtifactReuseDeadline,
  artifactMatchesClaim,
  buildRaceResolutionDisplayArtifactStore,
  raceResolutionDisplayArtifact,
};
