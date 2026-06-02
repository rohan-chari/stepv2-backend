const { prisma } = require("../db");

// Catalog of coin-purchasable powerups (separate from the cosmetic ShopItem
// table so the cosmetic catalog stays byte-compatible for old app versions).
const PowerupShopItem = {
  async findActive() {
    return prisma.powerupShopItem.findMany({
      where: { active: true },
      orderBy: [{ sortOrder: "asc" }, { name: "asc" }],
    });
  },

  async findBySku(sku) {
    return prisma.powerupShopItem.findUnique({ where: { sku } });
  },
};

module.exports = { PowerupShopItem };
