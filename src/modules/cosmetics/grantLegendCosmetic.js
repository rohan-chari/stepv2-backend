const { prisma } = require("../../db");

// The earn-only cosmetic minted to Legend-tier players at weekly settlement.
// Seeded by scripts/seed-legend-cosmetic.js; can't be bought (earnOnly) and
// never appears in the catalog.
const LEGEND_COSMETIC_SKU = "ranked_legend_crown";

// Idempotent: ownership is unique on (userId, shopItemId), so re-granting is a
// no-op. Missing item (not seeded yet) logs and skips — settlement must never
// fail over a cosmetic.
async function grantLegendCosmetic({ userId, sku = LEGEND_COSMETIC_SKU, logger = console }) {
  const item = await prisma.shopItem.findUnique({ where: { sku } });
  if (!item) {
    logger.warn(`[RANKED] Legend cosmetic "${sku}" not seeded; skipping grant`);
    return { granted: false };
  }
  await prisma.userShopItem.upsert({
    where: { userId_shopItemId: { userId, shopItemId: item.id } },
    create: { userId, shopItemId: item.id },
    update: {},
  });
  return { granted: true };
}

module.exports = { grantLegendCosmetic, LEGEND_COSMETIC_SKU };
