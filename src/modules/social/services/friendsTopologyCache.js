const { prisma: defaultPrisma } = require("../../../db");
const redisCacheDefault = require("../../../shared/cache/redisCache");
const derivedCacheDefault = require("../../../shared/cache/derivedCache");
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

function validItems(items) {
  return Array.isArray(items) && items.every((item) =>
    item && typeof item === "object" && !Array.isArray(item) &&
    Object.keys(item).length === 2 && typeof item.friendshipId === "string" &&
    typeof item.userId === "string"
  ) && new Set(items.map((item) => item.friendshipId)).size === items.length;
}

function validPayload(box, marker) {
  if (!Number.isSafeInteger(marker) || marker < 0 || !box || typeof box !== "object") return false;
  if (Object.keys(box).sort().join(",") !== "accepted,generation,incoming,outgoing") return false;
  if (box.generation !== marker || !validItems(box.accepted) ||
      !validItems(box.incoming) || !validItems(box.outgoing)) return false;
  const friendshipIds = [...box.accepted, ...box.incoming, ...box.outgoing]
    .map((item) => item.friendshipId);
  return new Set(friendshipIds).size === friendshipIds.length;
}

function buildFriendsTopologyCache(dependencies = {}) {
  const prisma = dependencies.prisma || defaultPrisma;
  const redisCache = dependencies.redisCache || redisCacheDefault;
  const derivedCache = dependencies.derivedCache || derivedCacheDefault;
  const cacheKeys = dependencies.cacheKeys || cacheKeysDefault;
  const settings = dependencies.appSettings || defaultAppSettings;
  const logger = dependencies.logger || console;

  async function loadFromPostgres(userId) {
    const [acceptedRows, incomingRows, outgoingRows] = await Promise.all([
      prisma.friendship.findMany({
        where: { status: "ACCEPTED", OR: [{ requesterId: userId }, { addresseeId: userId }] },
        select: { id: true, requesterId: true, addresseeId: true },
      }),
      prisma.friendship.findMany({
        where: { addresseeId: userId, status: "PENDING" },
        select: { id: true, requesterId: true },
      }),
      prisma.friendship.findMany({
        where: { requesterId: userId, status: "PENDING" },
        select: { id: true, addresseeId: true },
      }),
    ]);
    return {
      accepted: acceptedRows.map((row) => ({
        friendshipId: row.id,
        userId: row.requesterId === userId ? row.addresseeId : row.requesterId,
      })),
      incoming: incomingRows.map((row) => ({ friendshipId: row.id, userId: row.requesterId })),
      outgoing: outgoingRows.map((row) => ({ friendshipId: row.id, userId: row.addresseeId })),
    };
  }

  async function enabled() {
    try {
      const [guard, surface] = await Promise.all([
        settings.getFlag("redisPresentationGenerationGuardEnabled"),
        settings.getFlag("redisCacheFriendsEnabled"),
      ]);
      return guard === true && surface === true;
    } catch { return false; }
  }

  async function get(userId) {
    const started = Date.now();
    const payloadKey = cacheKeys.userFriends(userId);
    if (!(await enabled()) || !redisCache.isEnabled() ||
        derivedCache.isBypassed(payloadKey)) {
      const loaded = await loadFromPostgres(userId);
      logger.info?.("social-cache", {
        surface: "friends-topology", outcome: "bypass/error",
        durationMs: Date.now() - started,
      });
      return loaded;
    }
    derivedCache.ensureSubscribed();
    const generationKey = cacheKeys.userFriendsVersion(userId);
    const batch = await redisCache.getManyJSON([payloadKey, generationKey]);
    if (batch.ok && batch.values.length === 2 && validPayload(batch.values[0], batch.values[1])) {
      const { generation, ...payload } = batch.values[0];
      logger.info?.("social-cache", {
        surface: "friends-topology", outcome: "hit/fresh",
        durationMs: Date.now() - started,
      });
      return payload;
    }
    let loaded = null;
    const result = await redisCache.withWatch([generationKey, payloadKey], async (ctx) => {
      const current = await ctx.get(generationKey);
      const generation = Number.isSafeInteger(current) && current >= 0 ? current : 0;
      loaded = await loadFromPostgres(userId);
      return { sets: [
        { key: generationKey, value: generation, ttlSeconds: GENERATION_TTL_SECONDS },
        { key: payloadKey, value: { generation, ...loaded }, ttlSeconds: TTL_SECONDS },
      ] };
    });
    if (!loaded || result.disabled || (!result.installed && !result.aborted)) {
      loaded = await loadFromPostgres(userId);
    }
    logger.info?.("social-cache", {
      surface: "friends-topology", outcome: "miss",
      durationMs: Date.now() - started,
    });
    return loaded;
  }

  async function invalidateUserSafe(userId) {
    if (!userId || !redisCache.isEnabled() || !(await enabled())) return true;
    return derivedCache.invalidate({
      prefix: cacheKeys.userFriends(userId),
      run: () => redisCache.evalLua(
        ADVANCE_AND_DELETE_LUA,
        [cacheKeys.userFriendsVersion(userId), cacheKeys.userFriends(userId)],
        [GENERATION_TTL_SECONDS]
      ),
    });
  }

  async function invalidatePairSafe(a, b) {
    const results = await Promise.all([invalidateUserSafe(a), invalidateUserSafe(b)]);
    return results.every(Boolean);
  }

  async function invalidateUsersSafe(ids) {
    const results = await Promise.all([...new Set(ids || [])].filter(Boolean).map(invalidateUserSafe));
    return results.every(Boolean);
  }

  return { get, loadFromPostgres, invalidateUserSafe, invalidatePairSafe, invalidateUsersSafe };
}

const service = buildFriendsTopologyCache();
module.exports = { ...service, buildFriendsTopologyCache, TTL_SECONDS, GENERATION_TTL_SECONDS };
