const { prisma } = require("../db");
const {
  buildEquipmentMap,
  serializeShopItem,
} = require("../utils/shopCosmetics");

async function getShopCatalog(userId) {
  const [user, items, owned, equippedAccessories] = await Promise.all([
    prisma.user.findUnique({
      where: { id: userId },
      select: { coins: true },
    }),
    prisma.shopItem.findMany({
      where: { active: true },
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
  const equipped = buildEquipmentMap(equippedAccessories);
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
