const { prisma: defaultPrisma } = require("../../../db");
const derivedCacheDefault = require("../../../shared/cache/derivedCache");
const redisCacheDefault = require("../../../shared/cache/redisCache");
const cacheKeysDefault = require("../../../shared/cache/cacheKeys");
const { appSettings: defaultAppSettings } = require("../../../shared/config/appSettings");

const TTL_SECONDS = 3600;
const GENERATION_TTL_SECONDS = 7200;
const ADVANCE_AND_DELETE_LUA = `
local generation = redis.call('incr', KEYS[1])
redis.call('expire', KEYS[1], ARGV[1])
redis.call('del', KEYS[2])
return generation
`;

const USER_SELECT = {
  id: true,
  displayName: true,
  profilePhotoUrl: true,
  clientFeatures: true,
  isReviewAccount: true,
  hiddenFromLeaderboard: true,
  equippedAccessories: {
    include: {
      shopItem: {
        select: {
          id: true, sku: true, name: true, slot: true, assetKey: true,
          renderMetadata: true, bobble: true, testOnly: true, remoteOnly: true,
          assetVersion: true,
        },
      },
    },
  },
};

function project(user) {
  if (!user) return null;
  return {
    id: user.id,
    displayName: user.displayName ?? null,
    profilePhotoUrl: user.profilePhotoUrl ?? null,
    equippedAccessories: (user.equippedAccessories ?? []).map((accessory) => ({
      shopItem: accessory.shopItem,
    })),
    clientFeatures: Array.isArray(user.clientFeatures) ? user.clientFeatures : [],
    isReviewAccount: user.isReviewAccount === true,
    hiddenFromLeaderboard: user.hiddenFromLeaderboard === true,
  };
}

function validPresentation(value, id) {
  if (value === null) return true;
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const allowed = ["id", "displayName", "profilePhotoUrl", "equippedAccessories", "clientFeatures", "isReviewAccount", "hiddenFromLeaderboard"];
  if (Object.keys(value).some((key) => !allowed.includes(key))) return false;
  const validFeature = (feature) => typeof feature === "string";
  const validAccessory = (accessory) => {
    if (!accessory || typeof accessory !== "object" || Array.isArray(accessory) ||
        Object.keys(accessory).sort().join(",") !== "shopItem") return false;
    const item = accessory.shopItem;
    if (!item || typeof item !== "object" || Array.isArray(item)) return false;
    const allowedItem = ["assetKey", "assetVersion", "bobble", "id", "name", "remoteOnly", "renderMetadata", "sku", "slot", "testOnly"];
    if (Object.keys(item).some((key) => !allowedItem.includes(key))) return false;
    return ["id", "sku", "name", "slot", "assetKey"].every(
      (key) => typeof item[key] === "string"
    ) && (item.renderMetadata == null ||
      (typeof item.renderMetadata === "object" && !Array.isArray(item.renderMetadata))) &&
      typeof item.bobble === "boolean" && typeof item.testOnly === "boolean" &&
      typeof item.remoteOnly === "boolean" &&
      (item.assetVersion == null || typeof item.assetVersion === "string");
  };
  return value.id === id &&
    (value.displayName == null || typeof value.displayName === "string") &&
    (value.profilePhotoUrl == null || typeof value.profilePhotoUrl === "string") &&
    Array.isArray(value.equippedAccessories) && value.equippedAccessories.every(validAccessory) &&
    Array.isArray(value.clientFeatures) && value.clientFeatures.every(validFeature) &&
    typeof value.isReviewAccount === "boolean" &&
    typeof value.hiddenFromLeaderboard === "boolean";
}

function buildUserPresentationCache(dependencies = {}) {
  const prisma = dependencies.prisma || defaultPrisma;
  const redisCache = dependencies.redisCache || redisCacheDefault;
  const derivedCache = dependencies.derivedCache || derivedCacheDefault;
  const cacheKeys = dependencies.cacheKeys || cacheKeysDefault;
  const settings = dependencies.appSettings || defaultAppSettings;
  const logger = dependencies.logger || console;

  async function loadMany(ids) {
    const rows = await prisma.user.findMany({
      where: { id: { in: ids } },
      select: USER_SELECT,
    });
    const byId = new Map(rows.map((row) => [row.id, project(row)]));
    return new Map(ids.map((id) => [id, byId.get(id) ?? null]));
  }

  async function guardEnabled() {
    try {
      return (await settings.getFlag("redisPresentationGenerationGuardEnabled")) === true;
    } catch {
      return false;
    }
  }

  async function presentationCacheEnabled() {
    try {
      const values = await Promise.all([
        settings.getFlag("redisCacheMessagesEnabled"),
        settings.getFlag("redisCacheLeaderboardEnabled"),
        settings.getFlag("redisCacheFriendsEnabled"),
      ]);
      return values.some((value) => value === true);
    } catch {
      return false;
    }
  }

  async function getMany(userIds, enabled) {
    const started = Date.now();
    const unique = [...new Set((userIds || []).filter(Boolean))];
    if (unique.length === 0) return new Map();
    if (!enabled || !redisCache.isEnabled()) {
      const loaded = await loadMany(unique);
      logger.info?.("social-cache", {
        surface: "presentation", outcome: "bypass/error",
        durationMs: Date.now() - started,
      });
      return loaded;
    }

    if (!(await guardEnabled())) {
      const out = new Map();
      await Promise.all(unique.map(async (id) => {
        const value = await derivedCache.cachedRead({
          key: cacheKeys.userCosmetics(id),
          prefix: cacheKeys.PREFIX.USER_COSMETICS,
          ttlSeconds: TTL_SECONDS,
          enabled: true,
          load: async () => (await loadMany([id])).get(id),
        });
        out.set(id, value);
      }));
      logger.info?.("social-cache", {
        surface: "presentation", outcome: "bypass/error",
        durationMs: Date.now() - started,
      });
      return out;
    }

    if (unique.some((id) => derivedCache.isBypassed(cacheKeys.userCosmetics(id)))) {
      const loaded = await loadMany(unique);
      logger.info?.("social-cache", {
        surface: "presentation", outcome: "bypass/error",
        durationMs: Date.now() - started,
      });
      return loaded;
    }
    derivedCache.ensureSubscribed();
    const pairs = unique.flatMap((id) => [
      cacheKeys.userCosmetics(id),
      cacheKeys.userCosmeticsVersion(id),
    ]);
    const batch = await redisCache.getManyJSON(pairs);
    if (!batch.ok || batch.values.length !== pairs.length) {
      const loaded = await loadMany(unique);
      logger.info?.("social-cache", {
        surface: "presentation", outcome: "bypass/error",
        durationMs: Date.now() - started,
      });
      return loaded;
    }

    const out = new Map();
    const misses = [];
    for (let i = 0; i < unique.length; i += 1) {
      const id = unique[i];
      const box = batch.values[i * 2];
      const marker = batch.values[i * 2 + 1];
      const validMarker = Number.isSafeInteger(marker) && marker >= 0;
      const validBox = box && typeof box === "object" &&
        Object.keys(box).length === 2 && "v" in box &&
        Number.isSafeInteger(box.generation) && box.generation === marker &&
        validPresentation(box.v, id);
      if (validMarker && validBox) out.set(id, box.v);
      else misses.push(id);
    }
    if (misses.length === 0) {
      logger.info?.("social-cache", {
        surface: "presentation", outcome: "hit/fresh",
        durationMs: Date.now() - started,
      });
      return out;
    }

    const watchKeys = misses.flatMap((id) => [
      cacheKeys.userCosmeticsVersion(id), cacheKeys.userCosmetics(id),
    ]);
    let loaded = null;
    const install = await redisCache.withWatch(watchKeys, async (ctx) => {
      const generations = new Map();
      for (const id of misses) {
        const marker = await ctx.get(cacheKeys.userCosmeticsVersion(id));
        generations.set(id, Number.isSafeInteger(marker) && marker >= 0 ? marker : 0);
      }
      loaded = await loadMany(misses);
      const sets = [];
      for (const id of misses) {
        const generation = generations.get(id);
        sets.push({ key: cacheKeys.userCosmeticsVersion(id), value: generation, ttlSeconds: GENERATION_TTL_SECONDS });
        sets.push({ key: cacheKeys.userCosmetics(id), value: { v: loaded.get(id), generation }, ttlSeconds: TTL_SECONDS });
      }
      return { sets };
    });
    if (!loaded || install.disabled || (!install.installed && !install.aborted)) {
      loaded = await loadMany(misses);
    }
    for (const id of misses) out.set(id, loaded.get(id));
    logger.info?.("social-cache", {
      surface: "presentation", outcome: "miss",
      durationMs: Date.now() - started,
    });
    return out;
  }

  async function invalidate(userId) {
    if (!userId || !redisCache.isEnabled()) return true;
    const payloadKey = cacheKeys.userCosmetics(userId);
    if (!(await presentationCacheEnabled()) || !(await guardEnabled())) {
      return derivedCache.invalidate({
        prefix: payloadKey,
        run: () => redisCache.del(payloadKey),
      });
    }
    const generationKey = cacheKeys.userCosmeticsVersion(userId);
    return derivedCache.invalidate({
      prefix: payloadKey,
      run: () => redisCache.evalLua(
        ADVANCE_AND_DELETE_LUA,
        [generationKey, payloadKey],
        [GENERATION_TTL_SECONDS]
      ),
    });
  }

  return { getMany, invalidate, loadMany };
}

const service = buildUserPresentationCache();
module.exports = {
  ...service,
  buildUserPresentationCache,
  TTL_SECONDS,
  GENERATION_TTL_SECONDS,
  USER_SELECT,
  validPresentation,
};
