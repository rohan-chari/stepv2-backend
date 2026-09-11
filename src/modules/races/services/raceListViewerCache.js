const cacheKeys = require("../../../shared/cache/cacheKeys");
const redis = require("../../../shared/cache/redisCache");
const derived = require("../../../shared/cache/derivedCache");
const { capture, unchanged } = require("../../../shared/cache/cacheEfficiencyRead");

const CACHE_VERSION = 1;
const TTL_SECONDS = 30;
const MAX_RACES = 128;
const MAX_BYTES = 256 * 1024;
const DOMAIN_PREFIX = "ce:v1:";

function dateValue(value) {
  return value == null ? null : new Date(value).toISOString();
}

function project(row, userId, raceId) {
  if (!row) {
    return { schema: CACHE_VERSION, userId, raceId, participantId: null };
  }
  return {
    schema: CACHE_VERSION,
    userId,
    raceId,
    participantId: row.id || null,
    status: row.status || null,
    placement: row.placement == null ? null : Number(row.placement),
    favoritedAt: dateValue(row.favoritedAt),
    buyInStatus: row.buyInStatus || null,
    payoutCoins: row.payoutCoins == null ? null : Number(row.payoutCoins),
    resultsSeenAt: dateValue(row.resultsSeenAt),
    inviteExpiresAt: dateValue(row.inviteExpiresAt),
    team: row.team || null,
    forfeitedAt: dateValue(row.forfeitedAt),
    ...(Array.isArray(row._raceListMyActiveEffects)
      ? { myActiveEffects: row._raceListMyActiveEffects.map((effect) => ({ ...effect })) }
      : {}),
  };
}

function valid(value, userId, raceId, variant, generation) {
  const baseFields = ["generation", "participantId", "raceId", "schema", "userId", "variant"];
  const participantFields = ["buyInStatus", "favoritedAt", "forfeitedAt", "inviteExpiresAt",
    "payoutCoins", "placement", "resultsSeenAt", "status", "team"];
  if (!value || value.schema !== CACHE_VERSION || value.userId !== userId ||
      value.raceId !== raceId || value.variant !== variant ||
      value.generation !== generation ||
      (value.participantId != null && typeof value.participantId !== "string") ||
      (value.status != null && typeof value.status !== "string") ||
      (value.buyInStatus != null && typeof value.buyInStatus !== "string") ||
      (value.team != null && typeof value.team !== "string") ||
      (value.placement != null && (!Number.isSafeInteger(value.placement) || value.placement < 1)) ||
      (value.payoutCoins != null && (!Number.isSafeInteger(value.payoutCoins) || value.payoutCoins < 0)) ||
      !validDate(value.favoritedAt) || !validDate(value.resultsSeenAt) ||
      !validDate(value.inviteExpiresAt) || !validDate(value.forfeitedAt)) return false;
  const expectedFields = value.participantId == null
    ? baseFields
    : [...baseFields, ...participantFields,
      ...(Object.hasOwn(value, "myActiveEffects") ? ["myActiveEffects"] : [])];
  if (Object.keys(value).sort().join(",") !== expectedFields.sort().join(",")) return false;
  if (value.myActiveEffects != null) {
    if (!Array.isArray(value.myActiveEffects)) return false;
    for (const effect of value.myActiveEffects) {
      if (!effect || typeof effect !== "object" || typeof effect.type !== "string" ||
          (effect.sourceUserId != null && typeof effect.sourceUserId !== "string") ||
          !validDate(effect.expiresAt) || new Date(effect.expiresAt).getTime() <= Date.now() ||
          !["expiresAt,type", "expiresAt,sourceUserId,type"].includes(
            Object.keys(effect).sort().join(",")
          )) return false;
    }
  }
  return Buffer.byteLength(JSON.stringify(value), "utf8") <= MAX_BYTES;
}

function validDate(value) {
  return value == null || (typeof value === "string" && Number.isFinite(Date.parse(value)));
}

function revive(value) {
  if (!value || value.participantId == null) return null;
  return {
    id: value.participantId,
    raceId: value.raceId,
    userId: value.userId,
    status: value.status,
    placement: value.placement,
    favoritedAt: value.favoritedAt ? new Date(value.favoritedAt) : null,
    buyInStatus: value.buyInStatus,
    payoutCoins: value.payoutCoins,
    resultsSeenAt: value.resultsSeenAt ? new Date(value.resultsSeenAt) : null,
    inviteExpiresAt: value.inviteExpiresAt ? new Date(value.inviteExpiresAt) : null,
    team: value.team,
    forfeitedAt: value.forfeitedAt ? new Date(value.forfeitedAt) : null,
    myActiveEffects: Array.isArray(value.myActiveEffects)
      ? value.myActiveEffects.filter((effect) => new Date(effect.expiresAt).getTime() > Date.now())
      : null,
  };
}

function markerList(userId, raceIds) {
  return [
    { domain: "list", identity: userId },
    ...raceIds.flatMap((raceId) => [
      { domain: "race-summary", identity: raceId },
      { domain: "race-meta", identity: raceId },
      { domain: "race-effects", identity: raceId },
    ]),
  ];
}

function buildRaceListViewerCache({ redisCache = redis, derivedCache = derived } = {}) {
  async function readMany({ userId, raceIds = [], variant = "legacy" }) {
    const ids = [...new Set(raceIds.filter(Boolean))].slice(0, MAX_RACES);
    const misses = new Set(ids);
    if (!userId || ids.length === 0 || !redisCache.isEnabled?.() ||
        derivedCache.isBypassed?.(DOMAIN_PREFIX)) {
      return { values: new Map(), misses: ids, fence: null, source: "postgres" };
    }
    derivedCache.ensureSubscribed?.();
    let fence;
    let generation;
    try { fence = await capture(markerList(userId, ids)); } catch { fence = null; }
    if (!fence) return { values: new Map(), misses: ids, fence: null, source: "postgres" };
    try {
      const generationRead = await redisCache.getManyJSON([cacheKeys.raceListGeneration(userId)]);
      generation = Number(generationRead?.values?.[0] ?? 0);
      if (!Number.isSafeInteger(generation) || generation < 0) generation = 0;
    } catch { generation = 0; }
    const keys = ids.map((raceId) => cacheKeys.raceListViewer(userId, raceId, variant));
    let read;
    try { read = await redisCache.getManyJSON(keys); } catch { read = null; }
    const values = new Map();
    if (read?.ok === true) {
      ids.forEach((raceId, index) => {
        const value = read.values[index];
        if (valid(value, userId, raceId, variant, generation)) {
          values.set(raceId, revive(value));
          misses.delete(raceId);
        }
      });
      if (values.size > 0 && !(await unchanged(fence))) {
        return { values: new Map(), misses: ids, fence: null, source: "generation" };
      }
    }
    return { values, misses: [...misses], fence, generation, source: misses.size ? "mixed" : "redis" };
  }

  async function writeMany({ userId, variant = "legacy", rows = new Map(), fence = null, generation = 0 }) {
    if (!fence || !redisCache.isEnabled?.() || rows.size === 0) return false;
    if (derivedCache.isBypassed?.(DOMAIN_PREFIX) || !(await unchanged(fence))) return false;
    const entries = [];
    for (const [raceId, row] of rows) {
      const value = { ...project(row, userId, raceId), variant, generation };
      if (!valid(value, userId, raceId, variant, generation)) continue;
      entries.push({
        key: cacheKeys.raceListViewer(userId, raceId, variant),
        value,
        ttlSeconds: TTL_SECONDS,
      });
    }
    if (!entries.length) return false;
    return (await redisCache.setManyJSON(entries))?.ok === true;
  }

  return { readMany, writeMany };
}

const raceListViewerCache = buildRaceListViewerCache();

module.exports = {
  CACHE_VERSION,
  TTL_SECONDS,
  buildRaceListViewerCache,
  raceListViewerCache,
};
