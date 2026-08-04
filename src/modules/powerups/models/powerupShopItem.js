const { prisma } = require("../../../db");
const { testOnlyFilter } = require("../../../shared/middleware/releaseChannel");

// Catalog of coin-purchasable powerups (separate from the cosmetic ShopItem
// table so the cosmetic catalog stays byte-compatible for old app versions).
const PowerupShopItem = {
  // `supportsRemoteAssets` DEFAULTS TO TRUE so the other caller of this model —
  // the daily-spin prize pool (getEligiblePowerupPool) — is completely
  // unaffected: a powerup whose icon is CDN-served is still winnable from a
  // box, it just falls back to the generic bolt icon on a client that can't
  // fetch it. Only the shop catalog opts into the filter, because that's where
  // the client would otherwise be offered a purchase it can't render.
  async findActive({ channel = "prod", supportsRemoteAssets = true } = {}) {
    return prisma.powerupShopItem.findMany({
      where: {
        active: true,
        ...testOnlyFilter(channel),
        ...(supportsRemoteAssets ? {} : { assetVersion: null }),
      },
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
