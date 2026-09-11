const { Race } = require("../models/race");
const { isVisiblePublicRace } = require("./getPublicRaces");
const { appSettings: defaultAppSettings } = require("../../../shared/config/appSettings");
const { isStrictFlagEnabled } = require("../../../shared/config/isStrictFlagEnabled");
const crypto = require("node:crypto");
const defaultRedisCache = require("../../../shared/cache/redisCache");
const defaultDerivedCache = require("../../../shared/cache/derivedCache");
const cacheKeys = require("../../../shared/cache/cacheKeys");
const { capture, unchanged } = require("../../../shared/cache/cacheEfficiencyRead");

const COUNT_CACHE_VERSION = 1;
const COUNT_CACHE_TTL_SECONDS = 60;
const COUNT_CACHE_PREFIX = "ce:v1:";

function seededVisibilityFingerprint(hiddenSeededWindows) {
  const normalized = (hiddenSeededWindows || []).map((row) => ({
    seedId: row?.seedId || null,
    windowStart: row?.windowStart ? new Date(row.windowStart).toISOString() : null,
  })).sort((a, b) => JSON.stringify(a).localeCompare(JSON.stringify(b)));
  return crypto.createHash("sha256").update(JSON.stringify(normalized)).digest("hex").slice(0, 32);
}

// Count of browsable public races for the viewer, applying the SAME visibility,
// membership, capacity, seed, and team-race rules as getPublicRaces but without
// serializing race cards (§6.2 publicRaceCount). Uses the lean
// findPublicPendingLean fetch (same where clause + participant subset the
// predicate reads) so the count always equals getPublicRaces(...).length.
function buildGetPublicRaceCount(dependencies = {}) {
  const raceModel = dependencies.Race || Race;
  const settings = dependencies.appSettings || defaultAppSettings;
  const redisCache = dependencies.redisCache || defaultRedisCache;
  const derivedCache = dependencies.derivedCache || defaultDerivedCache;

  return async function getPublicRaceCount({
    userId,
    supportsTeamRaces = false,
    supportsLargeTeamRaces = false,
    excludeSeeded = false,
    hiddenSeededWindows = [],
  }) {
    const variant = [
      supportsTeamRaces ? "tm1" : "tm0",
      supportsLargeTeamRaces ? "tl1" : "tl0",
      excludeSeeded ? "es1" : "es0",
    ].join(":");
    const key = cacheKeys.publicRaceCount(
      userId,
      variant,
      seededVisibilityFingerprint(hiddenSeededWindows),
    );
    let fence = null;
    let cached = null;
    if (userId && redisCache.isEnabled?.() && !derivedCache.isBypassed?.(COUNT_CACHE_PREFIX)) {
      derivedCache.ensureSubscribed?.();
      try {
        fence = await capture([
          { domain: "event", identity: "public-race-discovery" },
          { domain: "list", identity: userId },
        ]);
        const read = await redisCache.getManyJSON([key]);
        const value = read?.ok === true ? read.values[0] : null;
        if (value?.schema === COUNT_CACHE_VERSION && value.userId === userId &&
            value.variant === variant && Number.isSafeInteger(value.count) && value.count >= 0 &&
            Array.isArray(value.tokens) && value.tokens.length === fence?.tokens?.length &&
            value.tokens.every((token, index) => token === fence.tokens[index]) &&
            await unchanged(fence)) cached = value.count;
      } catch {
        fence = null;
      }
    }
    if (cached != null) return cached;

    let sqlEnabled = false;
    if (dependencies.publicRaceCountSqlV1Enabled != null) {
      sqlEnabled = dependencies.publicRaceCountSqlV1Enabled === true;
    } else if (!dependencies.Race || dependencies.appSettings) {
      sqlEnabled = await isStrictFlagEnabled(
        settings,
        "publicRaceCountSqlV1Enabled"
      );
    }
    let count;
    if (sqlEnabled && typeof raceModel.countVisiblePublicRaces === "function") {
      count = await raceModel.countVisiblePublicRaces({
        userId,
        supportsTeamRaces,
        supportsLargeTeamRaces,
        excludeSeeded,
        hiddenSeededWindows,
      });
    } else {
      const hiddenWindows = new Set(hiddenSeededWindows.map(
      (row) => `${row.seedId}:${new Date(row.windowStart).toISOString()}`
      ));
      const races = await raceModel.findPublicPendingLean({ excludeSeeded });
      count = 0;
      for (const race of races) {
        if (race.seedId && hiddenWindows.has(`${race.seedId}:${new Date(race.scheduledStartAt || race.startedAt).toISOString()}`)) continue;
        if (isVisiblePublicRace(race, userId, supportsTeamRaces, supportsLargeTeamRaces)) count += 1;
      }
    }
    if (fence && await unchanged(fence)) {
      const value = {
        schema: COUNT_CACHE_VERSION,
        userId,
        variant,
        count,
        tokens: fence.tokens,
      };
      if (Buffer.byteLength(JSON.stringify(value), "utf8") < 4096) {
        await redisCache.setManyJSON([{ key, value, ttlSeconds: COUNT_CACHE_TTL_SECONDS }]);
      }
    }
    return count;
  };
}

const getPublicRaceCount = buildGetPublicRaceCount();

module.exports = { buildGetPublicRaceCount, getPublicRaceCount };
