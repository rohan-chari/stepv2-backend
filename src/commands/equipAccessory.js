const { prisma } = require("../db");
const { ACCESSORY_SLOTS, buildEquipmentMap } = require("../utils/shopCosmetics");

class AccessoryEquipError extends Error {
  constructor(message, statusCode = 400) {
    super(message);
    this.name = "AccessoryEquipError";
    this.statusCode = statusCode;
  }
}

async function getEquipment(userId, tx = prisma) {
  const equippedAccessories = await tx.userEquippedAccessory.findMany({
    where: { userId },
    include: { shopItem: true },
  });
  return buildEquipmentMap(equippedAccessories);
}

async function equipAccessory({ userId, slot, itemId, channel = "prod" }) {
  if (!ACCESSORY_SLOTS.includes(slot)) {
    throw new AccessoryEquipError("Accessory slot is invalid", 400);
  }

  if (itemId === null) {
    await prisma.userEquippedAccessory.deleteMany({
      where: { userId, slot },
    });
    return { equipped: await getEquipment(userId) };
  }

  if (typeof itemId !== "string" || itemId.trim().length === 0) {
    throw new AccessoryEquipError("itemId must be a shop item id or null", 400);
  }

  return prisma.$transaction(async (tx) => {
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

    return { equipped: await getEquipment(userId, tx) };
  });
}

module.exports = { equipAccessory, AccessoryEquipError };
