const { prisma } = require("../db");
const {
  buildEquipmentMap,
  serializeShopItem,
} = require("../utils/shopCosmetics");
const { testOnlyFilter } = require("../utils/releaseChannel");

async function getShopCatalog(userId, { channel = "prod" } = {}) {
  const [user, items, owned, equippedAccessories] = await Promise.all([
    prisma.user.findUnique({
      where: { id: userId },
      select: { coins: true },
    }),
    prisma.shopItem.findMany({
      where: { active: true, ...testOnlyFilter(channel) },
      orderBy: [{ sortOrder: "asc" }, { name: "asc" }],
    }),
    prisma.userShopItem.findMany({
      where: { userId },
      select: { shopItemId: true },
    }),
    prisma.userEquippedAccessory.findMany({
      where: { userId },
      include: { shopItem: true },
    }),
  ]);

  const ownedItemIds = owned.map((entry) => entry.shopItemId);
  const ownedItemIdSet = new Set(ownedItemIds);
  // On the prod channel, never surface a still-hidden item the user equipped
  // while on a TestFlight build — otherwise it would render on their prod
  // avatar (and reference an asset their prod binary may not bundle).
  const visibleEquipped =
    channel === "testflight"
      ? equippedAccessories
      : equippedAccessories.filter((entry) => !entry.shopItem?.testOnly);
  const equipped = buildEquipmentMap(visibleEquipped);
  const equippedItemIdSet = new Set(
    Object.values(equipped).map((item) => item.id)
  );

  return {
    coins: user?.coins ?? 0,
    ownedItemIds,
    equipped,
    items: items.map((item) =>
      serializeShopItem(item, {
        owned: ownedItemIdSet.has(item.id),
        equipped: equippedItemIdSet.has(item.id),
      })
    ),
  };
}

module.exports = { getShopCatalog };
