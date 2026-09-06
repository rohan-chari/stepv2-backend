const { prisma: defaultPrisma } = require("../../../db");
const derivedCacheDefault = require("../../../shared/cache/derivedCache");
const redisCacheDefault = require("../../../shared/cache/redisCache");
const cacheKeysDefault = require("../../../shared/cache/cacheKeys");
const { appSettings: defaultAppSettings } = require("../../../shared/config/appSettings");
const {
  startCapacityPhase,
} = require("../../../shared/observability/capacityPhaseMetrics");
const {
  scheduleBoundedBatchDrain,
} = require("../../../shared/batching/boundedBatchDrain");
const {
  safePublicDisplayName,
} = require("../../../shared/lib/displayNameValidator");

const TTL_SECONDS = 3600;
const GENERATION_TTL_SECONDS = 7200;
const DATABASE_BATCH_SIZE = 256;
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
    displayName: safePublicDisplayName(user.displayName),
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
  const databaseBatch = { pending: [], draining: false };

  async function loadMany(ids) {
    const rows = typeof prisma.$queryRawUnsafe === "function"
      ? await prisma.$queryRawUnsafe(
        `SELECT users.id,
                users.display_name AS "displayName",
                users.profile_photo_url AS "profilePhotoUrl",
                users.client_features AS "clientFeatures",
                users.is_review_account AS "isReviewAccount",
                users.hidden_from_leaderboard AS "hiddenFromLeaderboard",
                COALESCE(
                  jsonb_agg(
                    jsonb_build_object(
                      'shopItem', jsonb_build_object(
                        'id', item.id,
                        'sku', item.sku,
                        'name', item.name,
                        'slot', item.slot,
                        'assetKey', item.asset_key,
                        'renderMetadata', item.render_metadata,
                        'bobble', item.bobble,
                        'testOnly', item.test_only,
                        'remoteOnly', item.remote_only,
                        'assetVersion', item.asset_version
                      )
                    ) ORDER BY equipped.slot
                  ) FILTER (WHERE equipped.id IS NOT NULL),
                  '[]'::jsonb
                ) AS "equippedAccessories"
           FROM users
           LEFT JOIN user_equipped_accessories equipped ON equipped.user_id=users.id
           LEFT JOIN shop_items item ON item.id=equipped.shop_item_id
          WHERE users.id = ANY($1::text[])
          GROUP BY users.id`,
        ids,
      )
      : await prisma.user.findMany({
        where: { id: { in: ids } },
        select: USER_SELECT,
      });
    const byId = new Map(rows.map((row) => [row.id, project(row)]));
    return new Map(ids.map((id) => [id, byId.get(id) ?? null]));
  }

  // During an app-open wave, independently assembled race cards often ask for
  // overlapping presentation sets in the same event-loop turn. Prisma expands
  // the nested cosmetics relation into several queries, so issuing one call per
  // viewer creates thousands of otherwise tiny pool checkouts. Merge those
  // cold reads into bounded set queries and project the exact map each caller
  // requested; no response shape or cache semantics change.
  function loadManyBatched(ids) {
    const unique = [...new Set((ids || []).filter(Boolean))];
    if (unique.length === 0) return Promise.resolve(new Map());
    const promise = new Promise((resolve, reject) => {
      databaseBatch.pending.push({ ids: unique, resolve, reject });
    });
    scheduleBoundedBatchDrain(databaseBatch, async (requests) => {
      const allIds = [...new Set(requests.flatMap((request) => request.ids))];
      const loaded = new Map();
      for (let offset = 0; offset < allIds.length; offset += DATABASE_BATCH_SIZE) {
        const page = await loadMany(allIds.slice(offset, offset + DATABASE_BATCH_SIZE));
        for (const [id, value] of page) loaded.set(id, value);
      }
      for (const request of requests) {
        request.resolve(new Map(request.ids.map((id) => [id, loaded.get(id) ?? null])));
      }
    });
    return promise;
  }

  async function guardEnabled() {
    try {
      return (await settings.getFlag("redisPresentationGenerationGuardEnabled")) === true;
    } catch {
      return false;
    }
  }

  async function getMany(userIds, enabled) {
    const started = Date.now();
    const capacity = startCapacityPhase("presentation_cache");
    const unique = [...new Set((userIds || []).filter(Boolean))];
    let cacheHits = 0;
    let cacheMisses = 0;
    let cacheBypassedIdentities = 0;
    let cacheErrorOperations = 0;
    let cacheErrorFallbackIdentities = 0;
    let databaseLoadOperations = 0;
    let databaseLoadedIdentities = 0;
    let databaseLoadErrorOperations = 0;
    let cacheInstallOperations = 0;
    let cacheInstalledIdentities = 0;
    let capacityOutcome = "error";

    async function loadMeasured(ids) {
      databaseLoadOperations += 1;
      try {
        const loaded = await capacity.measurePhase("databaseLoad", () => loadManyBatched(ids));
        databaseLoadedIdentities += [...loaded.values()].filter(
          (value) => value !== null,
        ).length;
        return loaded;
      } catch (error) {
        databaseLoadErrorOperations += 1;
        throw error;
      }
    }

    try {
    if (unique.length === 0) {
      capacityOutcome = "empty";
      return new Map();
    }
    if (!enabled || !redisCache.isEnabled()) {
      cacheBypassedIdentities = unique.length;
      const loaded = await loadMeasured(unique);
      logger.info?.("social-cache", {
        surface: "presentation", outcome: "bypass/error",
        durationMs: Date.now() - started,
      });
      capacityOutcome = "bypass";
      return loaded;
    }

    if (!(await guardEnabled())) {
      const out = new Map();
      await Promise.all(unique.map(async (id) => {
        let loadedFromDatabase = false;
        const value = await derivedCache.cachedRead({
          key: cacheKeys.userCosmetics(id),
          prefix: cacheKeys.PREFIX.USER_COSMETICS,
          ttlSeconds: TTL_SECONDS,
          enabled: true,
          load: async () => {
            loadedFromDatabase = true;
            cacheMisses += 1;
            return (await loadMeasured([id])).get(id);
          },
        });
        if (!loadedFromDatabase) cacheHits += 1;
        out.set(id, value);
      }));
      logger.info?.("social-cache", {
        surface: "presentation", outcome: "bypass/error",
        durationMs: Date.now() - started,
      });
      capacityOutcome = "unguarded";
      return out;
    }

    if (unique.some((id) => derivedCache.isBypassed(cacheKeys.userCosmetics(id)))) {
      cacheBypassedIdentities = unique.length;
      const loaded = await loadMeasured(unique);
      logger.info?.("social-cache", {
        surface: "presentation", outcome: "bypass/error",
        durationMs: Date.now() - started,
      });
      capacityOutcome = "bypass";
      return loaded;
    }
    derivedCache.ensureSubscribed();
    const pairs = unique.flatMap((id) => [
      cacheKeys.userCosmetics(id),
      cacheKeys.userCosmeticsVersion(id),
    ]);
    const batch = await capacity.measurePhase(
      "cacheLookup",
      () => redisCache.getManyJSON(pairs),
    );
    if (!batch.ok || batch.values.length !== pairs.length) {
      cacheErrorOperations += 1;
      cacheErrorFallbackIdentities = unique.length;
      const loaded = await loadMeasured(unique);
      logger.info?.("social-cache", {
        surface: "presentation", outcome: "bypass/error",
        durationMs: Date.now() - started,
      });
      capacityOutcome = "cache-error";
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
    cacheHits = out.size;
    cacheMisses = misses.length;
    if (misses.length === 0) {
      logger.info?.("social-cache", {
        surface: "presentation", outcome: "hit/fresh",
        durationMs: Date.now() - started,
      });
      capacityOutcome = "hit";
      return out;
    }

    const watchKeys = misses.flatMap((id) => [
      cacheKeys.userCosmeticsVersion(id), cacheKeys.userCosmetics(id),
    ]);
    let loaded = null;
    cacheInstallOperations += 1;
    const install = await capacity.measurePhase("cacheInstall", () =>
      redisCache.withWatch(watchKeys, async (ctx) => {
      const generations = new Map();
      for (const id of misses) {
        const marker = await ctx.get(cacheKeys.userCosmeticsVersion(id));
        generations.set(id, Number.isSafeInteger(marker) && marker >= 0 ? marker : 0);
      }
      loaded = await loadMeasured(misses);
      const sets = [];
      for (const id of misses) {
        const generation = generations.get(id);
        sets.push({ key: cacheKeys.userCosmeticsVersion(id), value: generation, ttlSeconds: GENERATION_TTL_SECONDS });
        sets.push({ key: cacheKeys.userCosmetics(id), value: { v: loaded.get(id), generation }, ttlSeconds: TTL_SECONDS });
      }
      return { sets };
      })
    );
    if (install.installed) cacheInstalledIdentities = misses.length;
    if (!loaded || install.disabled || (!install.installed && !install.aborted)) {
      loaded = await loadMeasured(misses);
    }
    for (const id of misses) out.set(id, loaded.get(id));
    logger.info?.("social-cache", {
      surface: "presentation", outcome: "miss",
      durationMs: Date.now() - started,
    });
    capacityOutcome = "miss";
    return out;
    } finally {
      capacity.setCounts({
        requestedIdentities: unique.length,
        cacheHits,
        cacheMisses,
        cacheBypassedIdentities,
        cacheErrorOperations,
        cacheErrorFallbackIdentities,
        databaseLoadOperations,
        databaseLoadedIdentities,
        databaseLoadErrorOperations,
        cacheInstallOperations,
        cacheInstalledIdentities,
      });
      capacity.setDimensions({ cacheEnabled: enabled === true });
      capacity.finish(capacityOutcome);
    }
  }

  async function invalidate(userId) {
    if (!userId || !redisCache.isEnabled()) return true;
    const payloadKey = cacheKeys.userCosmetics(userId);
    if (!(await guardEnabled())) {
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
