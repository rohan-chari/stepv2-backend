const { prisma } = require("../db");

// Active accessories the user does NOT own yet — the pool the daily-box RARE
// roll draws from, and the preview shown on the reel.
async function getUnownedAccessoryPool(userId) {
  const [activeItems, owned] = await Promise.all([
    prisma.shopItem.findMany({
      where: { active: true },
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
