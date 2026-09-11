const crypto = require("node:crypto");
const cacheKeys = require("../../../shared/cache/cacheKeys");
const redis = require("../../../shared/cache/redisCache");
const derived = require("../../../shared/cache/derivedCache");
const { capture, unchanged } = require("../../../shared/cache/cacheEfficiencyRead");

const CACHE_VERSION = 1;
const TTL_SECONDS = 60;
const PREFIX = "ce:v1:";

function visibilityFingerprint(hiddenSeededWindows = []) {
  const rows = hiddenSeededWindows.map((row) => ({
    seedId: row?.seedId || null,
    windowStart: row?.windowStart ? new Date(row.windowStart).toISOString() : null,
  })).sort((a, b) => JSON.stringify(a).localeCompare(JSON.stringify(b)));
  return crypto.createHash("sha256").update(JSON.stringify(rows)).digest("hex").slice(0, 32);
}

function variant({ supportsTeamRaces, supportsLargeTeamRaces, supportsTournaments }) {
  return `tm${supportsTeamRaces ? 1 : 0}:tl${supportsLargeTeamRaces ? 1 : 0}:tt${supportsTournaments ? 1 : 0}`;
}

function buildRaceDiscoveryBadgeCache({ redisCache = redis, derivedCache = derived } = {}) {
  async function read({ userId, supportsTeamRaces, supportsLargeTeamRaces, supportsTournaments, hiddenSeededWindows }) {
    if (!userId || !redisCache.isEnabled?.() || derivedCache.isBypassed?.(PREFIX)) return { value: null, fence: null };
    const v = variant({ supportsTeamRaces, supportsLargeTeamRaces, supportsTournaments });
    const key = cacheKeys.publicRaceCount(userId, v, visibilityFingerprint(hiddenSeededWindows));
    const markers = [
      { domain: "event", identity: "public-race-discovery" },
      { domain: "list", identity: userId },
    ];
    try {
      derivedCache.ensureSubscribed?.();
      const fence = await capture(markers);
      if (!fence) return { value: null, fence: null };
      const result = await redisCache.getManyJSON([key]);
      const value = result?.ok === true ? result.values[0] : null;
      if (value?.schema !== CACHE_VERSION || value.userId !== userId || value.variant !== v ||
          !Number.isSafeInteger(value.count) || value.count < 0 ||
          !Array.isArray(value.tokens) || value.tokens.length !== fence.tokens.length ||
          !value.tokens.every((token, i) => token === fence.tokens[i]) || !(await unchanged(fence))) {
        return { value: null, fence };
      }
      return { value: value.count, fence };
    } catch {
      return { value: null, fence: null };
    }
  }

  async function write({ userId, supportsTeamRaces, supportsLargeTeamRaces, supportsTournaments, hiddenSeededWindows, count, fence }) {
    if (count == null || !fence || !redisCache.isEnabled?.() || derivedCache.isBypassed?.(PREFIX) || !(await unchanged(fence))) return false;
    const v = variant({ supportsTeamRaces, supportsLargeTeamRaces, supportsTournaments });
    const key = cacheKeys.publicRaceCount(userId, v, visibilityFingerprint(hiddenSeededWindows));
    const value = { schema: CACHE_VERSION, userId, variant: v, count, tokens: fence.tokens };
    return (await redisCache.setManyJSON([{ key, value, ttlSeconds: TTL_SECONDS }]))?.ok === true;
  }
  return { read, write };
}

const raceDiscoveryBadgeCache = buildRaceDiscoveryBadgeCache();

module.exports = { CACHE_VERSION, TTL_SECONDS, buildRaceDiscoveryBadgeCache, raceDiscoveryBadgeCache, visibilityFingerprint };
