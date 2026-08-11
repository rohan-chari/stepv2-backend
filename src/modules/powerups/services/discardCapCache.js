// C4 (`v1:user:discardcap:{id}`) — the viewer's remaining daily discard-coin
// cap, cached for 60s. Batch 2026-08-10b item 2.
//
// Backs `powerupData.discardCapRemaining` on `GET /races/:id/progress`, the
// hottest endpoint in the app. The underlying query sums the user's
// `powerup_discard` coin rows for their current LOCAL day, so it is cheap but
// not free, and it only runs at all when the viewer actually holds a HELD
// (discardable) row.
//
// REDIS IS AN OPTIMIZATION, NEVER A PRECONDITION. `cachedRead` falls through to
// Postgres on a disabled flag, an unset REDIS_URL, an open bypass, or any Redis
// error — so the field exists in dev, in CI (where REDIS_URL is unset) and
// during a Redis outage exactly as it does in prod. Omitting the field when the
// cache is unavailable would be backwards: it would make a display fix depend
// on a caching layer.
//
// INVALIDATION — the one write seam that can move this number:
//   * discardPowerup.js (the coin award)
// The 60s TTL is the backstop, and is also what heals the local-day rollover
// (the key carries no date component — see cacheKeys.userDiscardCap).
const derivedCache = require("../../../shared/cache/derivedCache");
const redisCache = require("../../../shared/cache/redisCache");
const cacheKeys = require("../../../shared/cache/cacheKeys");
const { appSettings: defaultAppSettings } = require("../../../shared/config/appSettings");
const { discardCapRemainingFor } = require("./discardRewards");

const TTL_SECONDS = 60;

/**
 * Whether to consult Redis at all. Two conditions, both required — the same
 * shape as `standingsCacheEnabled` in getRaceProgress, and for the same reason:
 * with REDIS_URL unset the wrapper is inert, and checking the flag first would
 * make the ~20 unit-test files that build the progress query with fake models
 * (no Redis, no database) reach for `app_settings`.
 */
async function cacheEnabled(settings = defaultAppSettings) {
  if (!redisCache.isEnabled()) return false;
  try {
    return (await settings.getFlag("redisCacheDiscardCapEnabled")) === true;
  } catch {
    return false;
  }
}

/**
 * @param {object} opts
 * @param {string} opts.userId
 * @param {string|null} opts.timezone the user's STORED zone (never the header
 *   alone — see the discard route's precedence comment).
 * @param {object} [opts.appSettings]
 * @returns {Promise<number>} coins of headroom left today, >= 0
 */
async function getDiscardCapRemaining({ userId, timezone, appSettings }) {
  const load = () => discardCapRemainingFor({ userId, timezone });
  const enabled = await cacheEnabled(appSettings || defaultAppSettings);
  const value = await derivedCache.cachedRead({
    key: cacheKeys.userDiscardCap(userId),
    prefix: cacheKeys.PREFIX.USER_DISCARD_CAP,
    ttlSeconds: TTL_SECONDS,
    enabled,
    load,
  });
  return Number.isFinite(value) ? value : 0;
}

/** Invalidate-only seam (spec §3): the new value is never written here. */
async function invalidate(userId) {
  if (!userId) return true;
  return derivedCache.invalidate({
    keys: [cacheKeys.userDiscardCap(userId)],
    prefix: cacheKeys.PREFIX.USER_DISCARD_CAP,
  });
}

/** Cache bookkeeping must never fail a ledgered coin write. */
async function invalidateSafe(userId) {
  try {
    return await invalidate(userId);
  } catch {
    return false;
  }
}

module.exports = {
  getDiscardCapRemaining,
  invalidate,
  invalidateSafe,
  TTL_SECONDS,
};
