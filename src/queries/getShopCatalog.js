const { prisma } = require("../db");
const {
  buildEquipmentMap,
  serializeShopItem,
  CHARACTER_SLOT,
} = require("../utils/shopCosmetics");
const { testOnlyFilter } = require("../utils/releaseChannel");

async function getShopCatalog(
  userId,
  { channel = "prod", supportsCharacters = false } = {}
) {
  const [user, items, owned, equippedAccessories] = await Promise.all([
    prisma.user.findUnique({
      where: { id: userId },
      select: { coins: true },
    }),
    prisma.shopItem.findMany({
      where: {
        active: true,
        earnOnly: false,
        ...testOnlyFilter(channel),
        // Clients that never declared `characters` support (every binary that
        // predates the feature) must not see CHARACTER items at all — they
        // would render them as HEAD accessories and could buy an animal they
        // can't display.
        ...(supportsCharacters ? {} : { slot: { not: CHARACTER_SLOT } }),
      },
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
  const visibleEquipped = equippedAccessories.filter(
    (entry) =>
      (channel === "testflight" || !entry.shopItem?.testOnly) &&
      // Same reasoning as the catalog filter: a CHARACTER row equipped from a
      // characters-capable build must not reach an old binary's `equipped`
      // map, or it renders as a floating accessory on the capybara.
      (supportsCharacters || entry.shopItem?.slot !== CHARACTER_SLOT)
  );
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
