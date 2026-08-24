// C4 (spec §3 key table `v1:user:{id}:daily:{date}`, §5 Phase E):
// a user's daily step total, cached per DATE for 60s.
//
// This exists for `GET /friends/steps` — 16,593 calls / 8 days, #3 by volume.
// The endpoint does ONE indexed `steps` lookup PER FRIEND per call, and its
// callers poll it, so a user with 20 friends costs 20 queries every refresh.
// The cache is keyed per FRIEND (not per viewer) because the same friend's
// total is read by every one of their friends — one cached value serves N
// viewers, which is where the actual saving is.
//
// PER-USER read-through (spec §5 Phase C's rule, applied here): a miss for one
// friend costs one indexed query for THAT friend only. A page is never refetched
// wholesale because one entry was cold.
//
// INVALIDATION: the daily total has exactly two writers — `recordSteps` (the
// legacy `POST /steps` path) and `recordStepSyncV2` (the canonical intake
// `POST /steps/sync-v2`). Both call `invalidate` after their write. POST
// `/steps/samples` does NOT write the daily row (it only persists samples), so
// it has nothing to invalidate. Account deletion drops the rows, but also the
// user, so their key is unreachable and expires on its own.
const { Steps } = require("../models/steps");
const derivedCache = require("../../../shared/cache/derivedCache");
const cacheKeys = require("../../../shared/cache/cacheKeys");

// 60s per the key table. Both write paths invalidate, so this only bounds a
// missed seam (or a write from a peer process whose DEL failed).
const TTL_SECONDS = 60;

async function loadOne(userId, date) {
  // Deliberately the SAME model call `getFriendsWithSteps` made before the
  // cache existed, so the flag-off path and the cache-miss path are literally
  // one function (spec §8 test 2's deep-equal parity is then structural).
  const row = await Steps.findByUserIdAndDate(userId, date);
  // 0 is a MEANINGFUL cached value (no row = no steps recorded), and the boxing
  // in `derivedCache.cachedRead` keeps it a HIT rather than an eternal miss.
  return row?.steps ?? 0;
}

/**
 * @param {string[]} userIds
 * @param {string} date YYYY-MM-DD (or anything `normalizeDate` accepts)
 * @param {boolean} enabled the C4 app-setting flag
 * @returns {Promise<Map<string, number>>}
 */
async function getMany(userIds, date, enabled) {
  const unique = [...new Set((userIds || []).filter(Boolean))];
  const day = cacheKeys.normalizeDate(date);
  const out = new Map();
  if (unique.length === 0) return out;

  if (!enabled) {
    // Flag off: byte-identical to the pre-cache code path — one lookup per user.
    const values = await Promise.all(unique.map((id) => loadOne(id, day)));
    unique.forEach((id, i) => out.set(id, values[i]));
    return out;
  }

  await Promise.all(
    unique.map(async (id) => {
      const value = await derivedCache.cachedRead({
        key: cacheKeys.userDaily(id, day),
        prefix: cacheKeys.PREFIX.USER_DAILY,
        ttlSeconds: TTL_SECONDS,
        enabled: true,
        load: () => loadOne(id, day),
      });
      out.set(id, typeof value === "number" ? value : 0);
    })
  );
  return out;
}

/**
 * Invalidation seam for the two daily-total writers. Invalidate-only (spec §3
 * "Write paths never write caches directly"): the new total is never SET here,
 * the next reader rebuilds it.
 */
async function invalidate(userId, date) {
  if (!userId || date == null) return true;
  return derivedCache.invalidate({
    keys: [cacheKeys.userDaily(userId, date)],
    prefix: cacheKeys.PREFIX.USER_DAILY,
  });
}

/** Never let cache bookkeeping fail a step sync. */
async function invalidateSafe(userId, date) {
  try {
    return await invalidate(userId, date);
  } catch {
    return false;
  }
}

module.exports = { getMany, invalidate, invalidateSafe, TTL_SECONDS };
