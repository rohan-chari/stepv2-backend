// C4 (spec §3 key table `v1:user:{id}:inventory`, §5 Phase E):
// the user's GLOBAL powerup inventory, cached for 60s.
//
// Backs `GET /powerups/inventory` (14,303 calls / 8 days, #6 by volume).
//
// WHAT IS CACHED: the unfiltered row set (`{powerupType, quantity}` for every
// row with quantity > 0), NOT the response payload. The response drops
// QUICKSAND for clients without the `powerups4` capability, and that filter is
// re-applied per request on the way out. Caching the filtered payload would
// need a variant key per capability combination, and getting that wrong means a
// frozen old binary is handed an item it cannot render — a correctness bug, not
// a freshness one (the same reasoning as the C1 catalog variant keys).
//
// INVALIDATION — every site that changes a user's `user_powerup_items` rows:
//   * purchasePowerupItem.js       (coin purchase, quantity increment)
//   * unlockPowerupWithAds.js      (ad-funded purchase, quantity increment)
//   * grantPowerupToUser.js        (daily reward box, drops, admin grants)
//   * redeemPowerupToRace.js       (decrementIfAvailable — the "use" seam)
//   * usePowerup.js                (discard hand-back of a redeemed powerup)
// The 60s TTL is the backstop for a missed one.
const { prisma } = require("../../../db");
const derivedCache = require("../../../shared/cache/derivedCache");
const cacheKeys = require("../../../shared/cache/cacheKeys");

const TTL_SECONDS = 60;

async function loadItems(userId) {
  const rows = await prisma.userPowerupItem.findMany({
    where: { userId },
    orderBy: { powerupType: "asc" },
  });
  return rows
    .filter((r) => (r.quantity ?? 0) > 0)
    .map((r) => ({ powerupType: r.powerupType, quantity: r.quantity }));
}

/**
 * @param {string} userId
 * @param {boolean} enabled the C4 app-setting flag
 * @returns {Promise<Array<{powerupType: string, quantity: number}>>}
 */
async function getItems(userId, enabled) {
  if (!enabled) return loadItems(userId);
  const value = await derivedCache.cachedRead({
    key: cacheKeys.userInventory(userId),
    prefix: cacheKeys.PREFIX.USER_INVENTORY,
    ttlSeconds: TTL_SECONDS,
    enabled: true,
    load: () => loadItems(userId),
  });
  return Array.isArray(value) ? value : [];
}

/** Invalidate-only seam (spec §3): the new inventory is never written here. */
async function invalidate(userId) {
  if (!userId) return true;
  return derivedCache.invalidate({
    keys: [cacheKeys.userInventory(userId)],
    prefix: cacheKeys.PREFIX.USER_INVENTORY,
  });
}

/**
 * Never let cache bookkeeping fail a purchase, a grant or a redeem — those are
 * ledgered, user-visible economy writes; a Redis hiccup must not roll one back.
 */
async function invalidateSafe(userId) {
  try {
    return await invalidate(userId);
  } catch {
    return false;
  }
}

module.exports = { getItems, invalidate, invalidateSafe, TTL_SECONDS };
