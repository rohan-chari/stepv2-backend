const { prisma } = require("../../db");
const {
  ACCESSORY_SLOTS,
  CHARACTER_SLOT,
  buildEquipmentMap,
} = require("./shopCosmetics");

class AccessoryEquipError extends Error {
  constructor(message, statusCode = 400) {
    super(message);
    this.name = "AccessoryEquipError";
    this.statusCode = statusCode;
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
    return { equipped: await getEquipment(userId, prisma, { supportsCharacters }) };
  }

  if (typeof itemId !== "string" || itemId.trim().length === 0) {
    throw new AccessoryEquipError("itemId must be a shop item id or null", 400);
  }

  const outcome = await prisma.$transaction(async (tx) => {
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

  return { equipped: outcome.equipped };
}

module.exports = { equipAccessory, AccessoryEquipError };
