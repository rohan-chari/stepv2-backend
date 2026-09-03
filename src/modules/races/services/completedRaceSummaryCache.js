const defaultRedisCache = require("../../../shared/cache/redisCache");
const defaultDerivedCache = require("../../../shared/cache/derivedCache");
const cacheKeys = require("../../../shared/cache/cacheKeys");

const CACHE_VERSION = 1;
const TTL_SECONDS = 30 * 24 * 60 * 60;
const MAX_PAYLOAD_BYTES = 4 * 1024 * 1024;
const ROUTINE_OUTCOMES = new Set(["hit", "miss", "write", "bypass"]);

const ALLOWED_FIELDS = Object.freeze([
  "version", "raceId", "acceptedCount", "teamACount", "teamBCount",
  "teamAPayoutRecipientCount", "teamBPayoutRecipientCount",
  "completedPayouts", "teamASteps", "teamBSteps", "totalsAsOf",
  "leaderParticipantId", "leaderUserId", "leaderTotalSteps",
  "leaderPlacement", "leaderFinishedAt", "leaderJoinedAt",
  "ambiguousFinisherOrder",
]);

function isObject(value) {
  return value != null && typeof value === "object" && !Array.isArray(value);
}

function projectPayload(value) {
  if (!isObject(value)) return null;
  const payload = {};
  for (const field of ALLOWED_FIELDS) {
    if (Object.prototype.hasOwnProperty.call(value, field)) payload[field] = value[field];
  }
  for (const field of [
    "totalsAsOf", "leaderFinishedAt", "leaderJoinedAt",
  ]) {
    if (payload[field] instanceof Date) payload[field] = payload[field].toISOString();
  }
  return payload;
}

function validNullableId(value) {
  return value == null || (typeof value === "string" && value.length > 0);
}

function validNullableDate(value) {
  return value == null ||
    (typeof value === "string" && Number.isFinite(Date.parse(value)));
}

function payloadClassification(value, expectedRaceId) {
  let bytes;
  try {
    bytes = Buffer.byteLength(JSON.stringify(value), "utf8");
  } catch {
    return "malformed";
  }
  if (bytes > MAX_PAYLOAD_BYTES) return "oversized";
  if (!isObject(value) || value.version !== CACHE_VERSION ||
    value.raceId !== expectedRaceId ||
    !Number.isSafeInteger(value.acceptedCount) || value.acceptedCount < 0 ||
    !Number.isSafeInteger(value.teamACount) || value.teamACount < 0 ||
    !Number.isSafeInteger(value.teamBCount) || value.teamBCount < 0 ||
    !Number.isSafeInteger(value.teamAPayoutRecipientCount) ||
    value.teamAPayoutRecipientCount < 0 ||
    !Number.isSafeInteger(value.teamBPayoutRecipientCount) ||
    value.teamBPayoutRecipientCount < 0 ||
    !Array.isArray(value.completedPayouts) || value.completedPayouts.some(
      (amount) => !Number.isSafeInteger(Number(amount)) || Number(amount) < 0) ||
    !/^\d+$/.test(value.teamASteps) || !/^\d+$/.test(value.teamBSteps) ||
    !validNullableDate(value.totalsAsOf) ||
    !validNullableId(value.leaderParticipantId) ||
    !validNullableId(value.leaderUserId) ||
    (value.leaderTotalSteps != null && !Number.isFinite(Number(value.leaderTotalSteps))) ||
    (value.leaderPlacement != null &&
      (!Number.isSafeInteger(Number(value.leaderPlacement)) ||
       Number(value.leaderPlacement) < 1)) ||
    !validNullableDate(value.leaderFinishedAt) ||
    !validNullableDate(value.leaderJoinedAt) ||
    typeof value.ambiguousFinisherOrder !== "boolean") {
    return "malformed";
  }
  return "valid";
}

function validPayload(value, expectedRaceId) {
  return payloadClassification(value, expectedRaceId) === "valid";
}

function resultVersion(race) {
  const date = race?.updatedAt instanceof Date
    ? race.updatedAt
    : new Date(race?.updatedAt);
  if (!race?.id || !Number.isFinite(date.getTime())) return null;
  return date.toISOString();
}

function asMap(value) {
  if (value instanceof Map) return value;
  if (!Array.isArray(value)) return new Map();
  return new Map(value.filter((row) => row?.raceId).map((row) => [row.raceId, row]));
}

function metric(logger, fields) {
  const event = { event: "completed_race_summary_cache_v1", surface: "races", ...fields };
  try {
    logger?.log?.(logger === console ? JSON.stringify(event) : event);
  } catch {}
}

function createCompletedSummaryRecorder({
  logger = console,
  env = process.env,
  successEvery = 100,
} = {}) {
  const interval = Math.max(1, Number(successEvery) || 100);
  const counts = new Map();
  return (fields) => {
    const outcome = fields?.outcome || "unknown";
    const routine = ROUTINE_OUTCOMES.has(outcome);
    const seen = counts.get(outcome) || 0;
    counts.set(outcome, seen + 1);
    const capacityMode = env.CAPACITY_MODE === "true" || env.CAPACITY_MODE === "1";
    if (!routine || capacityMode || seen % interval === 0) metric(logger, fields);
  };
}

function buildCompletedRaceSummaryCache({
  redisCache = defaultRedisCache,
  derivedCache = defaultDerivedCache,
  logger = console,
  env = process.env,
  successEvery = 100,
} = {}) {
  const inflight = new Map();
  const record = createCompletedSummaryRecorder({ logger, env, successEvery });

  async function authoritative(races, load) {
    const loaded = asMap(await load(races.map((race) => race.id)));
    const out = new Map();
    for (const race of races) {
      const payload = projectPayload(loaded.get(race.id));
      const classification = payloadClassification(payload, race.id);
      // Cache validation protects Redis, not the request path. PostgreSQL
      // remains authoritative: once the projected row identifies the expected
      // race and schema version, return it even when it is not cache-eligible.
      // The write filter below still excludes malformed and oversized values.
      if (payload?.raceId === race.id && payload.version === CACHE_VERSION) {
        out.set(race.id, payload);
      }
      if (loaded.has(race.id) && classification !== "valid") {
        record({ outcome: classification, raceCount: 1 });
      }
    }
    return out;
  }

  async function getMany({ races = [], load }) {
    const unique = [...new Map((races || [])
      .filter((race) => race?.status === "COMPLETED" && race?.id)
      .map((race) => [race.id, race])).values()];
    if (unique.length === 0) return new Map();
    if (typeof load !== "function") throw new TypeError("completed summary loader is required");

    const entries = unique.map((race) => {
      const version = resultVersion(race);
      return version ? {
        race,
        key: cacheKeys.completedRaceSummary(race.id, version),
      } : { race, key: null };
    });

    if (!redisCache.isEnabled?.() ||
      derivedCache.isBypassed?.(cacheKeys.PREFIX.COMPLETED_RACE_SUMMARY)) {
      record({ outcome: "bypass", raceCount: unique.length });
      return authoritative(unique, load);
    }
    derivedCache.ensureSubscribed?.();

    const out = new Map();
    const cacheable = entries.filter((entry) => entry.key);
    let read = null;
    try {
      read = await redisCache.getManyJSON(cacheable.map((entry) => entry.key));
    } catch {
      record({ outcome: "redis_error", operation: "read", raceCount: unique.length });
    }
    if (read && read.ok !== true) {
      record({ outcome: "redis_error", operation: "read", raceCount: unique.length });
    }
    const values = read?.ok === true && Array.isArray(read.values) ? read.values : [];
    const misses = [];
    let hitCount = 0;
    let malformedCount = 0;
    let oversizedCount = 0;
    cacheable.forEach((entry, index) => {
      const value = values[index];
      const payload = projectPayload(value);
      const classification = payloadClassification(payload, entry.race.id);
      if (classification === "valid") {
        out.set(entry.race.id, payload);
        hitCount += 1;
      } else {
        if (value != null && classification === "malformed") malformedCount += 1;
        if (value != null && classification === "oversized") oversizedCount += 1;
        misses.push(entry);
      }
    });
    if (hitCount > 0) record({ outcome: "hit", raceCount: hitCount });
    if (malformedCount > 0) {
      record({ outcome: "malformed", raceCount: malformedCount });
    }
    if (oversizedCount > 0) {
      record({ outcome: "oversized", raceCount: oversizedCount });
    }
    for (const entry of entries.filter((candidate) => !candidate.key)) misses.push(entry);

    const owned = misses.filter((entry) => entry.key == null || !inflight.has(entry.key));
    const waiting = misses.filter((entry) => entry.key != null && inflight.has(entry.key));
    if (owned.length > 0) {
      const batchPromise = authoritative(owned.map((entry) => entry.race), load);
      for (const entry of owned) {
        if (entry.key) inflight.set(entry.key,
          batchPromise.then((loaded) => loaded.get(entry.race.id) || null));
      }
      try {
        const loaded = await batchPromise;
        for (const [raceId, payload] of loaded) out.set(raceId, payload);
        const writes = owned
          .filter((entry) => entry.key &&
            validPayload(loaded.get(entry.race.id), entry.race.id))
          .map((entry) => ({
            key: entry.key,
            value: loaded.get(entry.race.id),
            ttlSeconds: TTL_SECONDS,
          }));
        if (writes.length > 0) {
          let write;
          try {
            write = await redisCache.setManyJSON(writes);
          } catch {
            write = null;
          }
          record({
            outcome: write?.ok === true ? "write" : "redis_error",
            operation: "write",
            raceCount: writes.length,
          });
        }
        record({ outcome: "miss", raceCount: owned.length });
      } finally {
        for (const entry of owned) {
          if (entry.key) inflight.delete(entry.key);
        }
      }
    }
    await Promise.all(waiting.map(async (entry) => {
      const payload = await inflight.get(entry.key);
      if (payload) out.set(entry.race.id, payload);
    }));
    return new Map(unique.filter((race) => out.has(race.id))
      .map((race) => [race.id, out.get(race.id)]));
  }

  return { getMany };
}

const completedRaceSummaryCache = buildCompletedRaceSummaryCache();

module.exports = {
  buildCompletedRaceSummaryCache,
  completedRaceSummaryCache,
  CACHE_VERSION,
  TTL_SECONDS,
  MAX_PAYLOAD_BYTES,
  payloadClassification,
  createCompletedSummaryRecorder,
};
