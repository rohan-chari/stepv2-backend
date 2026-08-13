const { prisma } = require("../../db");
const {
  ACCESSORY_SLOTS,
  CHARACTER_SLOT,
  buildEquipmentMap,
} = require("./shopCosmetics");
const { appSettings } = require("../../shared/config/appSettings");
const { findConflictingEquipment } = require("./accessoryCompatibility");

class AccessoryEquipError extends Error {
  constructor(message, statusCode = 400, extras = {}) {
    super(message);
    this.name = "AccessoryEquipError";
    this.statusCode = statusCode;
    Object.assign(this, extras);
  }
}

async function getEquipment(userId, tx = prisma, { supportsCharacters = false } = {}) {
  const equippedAccessories = await tx.userEquippedAccessory.findMany({
    where: { userId },
    include: { shopItem: true },
  });
  // Old binaries (no `characters` capability) render every entry of this map
  // as an accessory on the capybara, so an equipped CHARACTER row must be
  // withheld from them.
  const visible = supportsCharacters
    ? equippedAccessories
    : equippedAccessories.filter((entry) => entry.shopItem?.slot !== CHARACTER_SLOT);
  return buildEquipmentMap(visible);
}

async function equipAccessory({
  userId,
  slot,
  itemId,
  channel = "prod",
  supportsCharacters = false,
}) {
  if (!ACCESSORY_SLOTS.includes(slot)) {
    throw new AccessoryEquipError("Accessory slot is invalid", 400);
  }

  // A client that can't render characters has no business equipping one; only
  // builds that send the `characters` capability may touch this slot.
  if (slot === CHARACTER_SLOT && !supportsCharacters) {
    throw new AccessoryEquipError("Accessory slot is invalid", 400);
  }

  if (itemId === null) {
    await prisma.userEquippedAccessory.deleteMany({
      where: { userId, slot },
    });
    // C2 invalidation (spec §3 `v1:user:{id}:cosmetics`): the UNEQUIP branch
    // returns early and runs outside the $transaction below, so it needs its
    // own hook — a single hook after the transaction would silently miss it.
    await invalidatePresentation(userId);
    return { equipped: await getEquipment(userId, prisma, { supportsCharacters }) };
  }

  if (typeof itemId !== "string" || itemId.trim().length === 0) {
    throw new AccessoryEquipError("itemId must be a shop item id or null", 400);
  }

  const compatibilityEnforced =
    (await appSettings.getFlag("accessoryCompatibilityEnforcement")) === true;

  const outcome = await prisma.$transaction(async (tx) => {
    // One per-user row lock serializes all cross-slot equip attempts. The slot
    // unique index alone cannot protect a HEAD/FACE conflict because each
    // request writes a different row. Lock before the equipment read, then
    // re-read inside the same transaction so exactly one racing request wins.
    if (compatibilityEnforced) {
      await tx.$queryRaw`
        SELECT 1 FROM "users" WHERE "id" = ${userId} FOR UPDATE
      `;
    }
    const ownership = await tx.userShopItem.findUnique({
      where: { userId_shopItemId: { userId, shopItemId: itemId } },
      include: { shopItem: true },
    });

    if (!ownership) {
      throw new AccessoryEquipError("You do not own this shop item", 403);
    }

    if (!ownership.shopItem.active) {
      throw new AccessoryEquipError("Shop item is no longer available", 400);
    }

    // A prod-channel session can't equip a still-hidden (test-only) item, even
    // one the user bought from a TestFlight build — keeps it off prod avatars.
    if (channel !== "testflight" && ownership.shopItem.testOnly) {
      throw new AccessoryEquipError("Shop item is no longer available", 400);
    }

    if (ownership.shopItem.slot !== slot) {
      throw new AccessoryEquipError("Shop item does not fit this slot", 400);
    }

    if (compatibilityEnforced) {
      const equippedAccessories = await tx.userEquippedAccessory.findMany({
        where: { userId },
        include: { shopItem: true },
      });
      // The same-slot item is being replaced by the candidate and is therefore
      // not part of the resulting loadout.
      const conflicts = findConflictingEquipment(
        ownership.shopItem,
        equippedAccessories.filter((entry) => entry.slot !== slot)
      );
      if (conflicts.length > 0) {
        const first = conflicts[0];
        throw new AccessoryEquipError(
          `That accessory conflicts with ${first.shopItem.name}.`,
          409,
          {
            code: "ACCESSORY_CONFLICT",
            conflictingItemIds: conflicts.map((entry) => entry.shopItemId),
            conflictingSlots: conflicts.map((entry) => entry.slot),
          }
        );
      }
    }

    await tx.userEquippedAccessory.upsert({
      where: { userId_slot: { userId, slot } },
      update: { shopItemId: ownership.shopItemId },
      create: { userId, slot, shopItemId: ownership.shopItemId },
    });

    return {
      equipped: await getEquipment(userId, tx, { supportsCharacters }),
      assetKey: ownership.shopItem.assetKey ?? null,
    };
  });

  // C2 invalidation: equip changes the user's presentation everywhere it is
  // hydrated at read time (chat senders today; leaderboard/social later). One
  // user-scoped DEL propagates to every surface — no message list is touched.
  await invalidatePresentation(userId);

  return { equipped: outcome.equipped };
}

// Kept defensive: cosmetics must never fail to equip because a cache DEL threw.
async function invalidatePresentation(userId) {
  try {
    const {
      invalidate,
    } = require("../social/services/userPresentationCache");
    await invalidate(userId);
  } catch {}
  // C5 (spec §5 Phase E2): equip/unequip is on the spec's named invalidation
  // list for `v1:user:{id}:authme`, and the client refreshes profile surfaces
  // right after a cosmetics change. Same defensive posture as above — equipping
  // must never fail because a cache DEL threw.
  try {
    await require("../users/services/authMeCache").invalidateSafe(userId);
  } catch {}
}

module.exports = { equipAccessory, AccessoryEquipError };
