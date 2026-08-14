const redisCacheDefault = require("../../../shared/cache/redisCache");
const cacheKeysDefault = require("../../../shared/cache/cacheKeys");

const TTL_SECONDS = 120;
const INCREMENT_LUA = `
local count = redis.call('incr', KEYS[1])
if count == 1 then redis.call('expire', KEYS[1], ARGV[1]) end
return count
`;

function buildFriendSearchRateLimiter(dependencies = {}) {
  const redisCache = dependencies.redisCache || redisCacheDefault;
  const cacheKeys = dependencies.cacheKeys || cacheKeysDefault;

  return async function consume(userId, current) {
    const at = current instanceof Date ? current : new Date(current);
    const minuteEpoch = Math.floor(at.getTime() / 60_000);
    const windowStart = new Date(minuteEpoch * 60_000);
    const result = await redisCache.evalLua(
      INCREMENT_LUA,
      [cacheKeys.friendSearchRate(userId, minuteEpoch)],
      [TTL_SECONDS]
    );
    const count = result.result;
    if (!result.ok || typeof count !== "number" ||
        !Number.isSafeInteger(count) || count <= 0) return null;
    return { count, windowStart };
  };
}

const friendSearchRateLimiter = buildFriendSearchRateLimiter();
module.exports = { buildFriendSearchRateLimiter, friendSearchRateLimiter, TTL_SECONDS };
