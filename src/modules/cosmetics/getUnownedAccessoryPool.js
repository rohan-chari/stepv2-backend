const { prisma } = require("../../db");
const { CHARACTER_SLOT } = require("./shopCosmetics");

// Active accessories the user does NOT own yet — the pool the daily-box RARE
// roll draws from, and the preview shown on the reel. Excludes earn-only
// cosmetics (e.g. the Legend ranked crown — granted by their own systems,
// never winnable), test-only items (prod builds don't bundle their assets),
// and CHARACTER-slot items (purchase-only: old binaries can't render them,
// and a premium base body must never drop from a free spin).
async function getUnownedAccessoryPool(userId) {
  const [activeItems, owned] = await Promise.all([
    prisma.shopItem.findMany({
      where: {
        active: true,
        earnOnly: false,
        testOnly: false,
        slot: { not: CHARACTER_SLOT },
      },
      orderBy: [{ sortOrder: "asc" }, { name: "asc" }],
    }),
    prisma.userShopItem.findMany({
      where: { userId },
      select: { shopItemId: true },
    }),
  ]);
  const ownedIds = new Set(owned.map((r) => r.shopItemId));
  return activeItems.filter((item) => !ownedIds.has(item.id));
}

module.exports = { getUnownedAccessoryPool };
