// C2 (spec §3 key table `v1:user:{id}:cosmetics`, §5 Phase C): the per-user
// presentation bundle that chat (and, later, leaderboard) hydrates at READ time.
//
// Why this key exists at all: caching chat message lists WITH the sender's
// name/photo/cosmetics baked in would mean an equip or a rename had to
// invalidate every message list in every race that user ever posted in — an
// unbounded fan-out. Instead the lists hold raw rows, this key holds the
// mutable per-user part, and the two are joined per request. One user-scoped
// DEL then propagates everywhere.
//
// SCOPE NOTE (deliberate, and reported to the owner): the chat payload today
// carries only `senderId`/`senderName`/`senderPhotoUrl` — it has NEVER carried
// cosmetics (see `senderInclude` in models/raceMessage.js). Spec §2's non-goal
// "no API shape change of any kind" forbids adding them here, so this bundle
// caches the equipped accessories/character for the surfaces that already serve
// them while chat consumes only the name + photo. The invalidation seams
// (equip/unequip, account delete) are wired exactly as §3 requires either way.
const { prisma } = require("../../../db");
const derivedCache = require("../../../shared/cache/derivedCache");
const cacheKeys = require("../../../shared/cache/cacheKeys");

// 1h per the key table. Every field here has an explicit invalidation seam, so
// the TTL is only the backstop for a missed one.
const TTL_SECONDS = 3600;

const USER_SELECT = {
  id: true,
  displayName: true,
  profilePhotoUrl: true,
  equippedAccessories: {
    include: {
      shopItem: {
        select: {
          id: true,
          sku: true,
          name: true,
          slot: true,
          assetKey: true,
          renderMetadata: true,
          bobble: true,
          testOnly: true,
          assetVersion: true,
        },
      },
    },
  },
};

async function loadOne(userId) {
  const user = await prisma.user.findUnique({
    where: { id: userId },
    select: USER_SELECT,
  });
  // `null` is a MEANINGFUL cached value: the user was deleted. Chat relies on
  // it to null out sender fields exactly the way the Postgres path does (see
  // deleteUserAccount, which nulls `race_messages.sender_id`).
  if (!user) return null;
  return {
    id: user.id,
    displayName: user.displayName ?? null,
    profilePhotoUrl: user.profilePhotoUrl ?? null,
    equippedAccessories: user.equippedAccessories ?? [],
  };
}

/**
 * @param {string[]} userIds
 * @param {boolean} enabled surface flag; false => straight Postgres
 * @returns {Promise<Map<string, object|null>>} null value = no such user
 */
async function getMany(userIds, enabled) {
  const unique = [...new Set(userIds.filter(Boolean))];
  const out = new Map();
  if (unique.length === 0) return out;

  if (!enabled) {
    const rows = await prisma.user.findMany({
      where: { id: { in: unique } },
      select: USER_SELECT,
    });
    const byId = new Map(rows.map((r) => [r.id, r]));
    for (const id of unique) {
      const user = byId.get(id);
      out.set(
        id,
        user
          ? {
              id: user.id,
              displayName: user.displayName ?? null,
              profilePhotoUrl: user.profilePhotoUrl ?? null,
              equippedAccessories: user.equippedAccessories ?? [],
            }
          : null
      );
    }
    return out;
  }

  // Per-user read-through: a miss costs one indexed query for THAT user only,
  // never a refetch of the whole page (spec §5 Phase C "falling through to PG
  // per user on miss").
  await Promise.all(
    unique.map(async (id) => {
      const value = await derivedCache.cachedRead({
        key: cacheKeys.userCosmetics(id),
        prefix: cacheKeys.PREFIX.USER_COSMETICS,
        ttlSeconds: TTL_SECONDS,
        enabled: true,
        load: () => loadOne(id),
      });
      out.set(id, value);
    })
  );
  return out;
}

/**
 * Invalidation seam for equip/unequip, profile mutation and account delete.
 * Invalidate-only: the new presentation is never written from a write path (§3).
 */
async function invalidate(userId) {
  if (!userId) return true;
  return derivedCache.invalidate({
    keys: [cacheKeys.userCosmetics(userId)],
    prefix: cacheKeys.PREFIX.USER_COSMETICS,
  });
}

module.exports = { getMany, invalidate, TTL_SECONDS };
