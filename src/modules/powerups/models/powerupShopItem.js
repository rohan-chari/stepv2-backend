const { prisma } = require("../../../db");
const { testOnlyFilter } = require("../../../shared/middleware/releaseChannel");

// Catalog of coin-purchasable powerups (separate from the cosmetic ShopItem
// table so the cosmetic catalog stays byte-compatible for old app versions).
const PowerupShopItem = {
  async findActive({ channel = "prod" } = {}) {
    return prisma.powerupShopItem.findMany({
      where: { active: true, ...testOnlyFilter(channel) },
      orderBy: [{ sortOrder: "asc" }, { name: "asc" }],
    });
  },

  async findBySku(sku) {
    return prisma.powerupShopItem.findUnique({ where: { sku } });
  },
};

// Shape sent to the client for a powerup won from (or previewed in) the daily
// box. `powerupType` drives the reel/reveal icon (PowerupIcon maps type →
// asset); name/sku/description are for display. Kept small and additive so old
// clients that never read it are unaffected.
function serializePowerupShopItem(item) {
  return {
    sku: item.sku,
    name: item.name,
    description: item.description ?? null,
    priceCoins: item.priceCoins,
    powerupType: item.powerupType,
  };
}

module.exports = { PowerupShopItem, serializePowerupShopItem };
