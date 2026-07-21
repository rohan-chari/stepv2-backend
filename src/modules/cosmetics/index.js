// Public interface of the cosmetics module (audit Phase 9g): catalog +
// purchase/equip commands, the legend-cosmetic grant (ranked settlement's one
// inbound edge), the peer-DB shop-item mirror (admin's edge), and the full
// cosmetic presentation surface (shopCosmetics) that economy/race/social
// serializers render capybaras with.
const shopCosmetics = require("./shopCosmetics");
const { getShopCatalog } = require("./getShopCatalog");
const { getUnownedAccessoryPool } = require("./getUnownedAccessoryPool");
const { purchaseShopItem, ShopPurchaseError } = require("./purchaseShopItem");
const { equipAccessory, AccessoryEquipError } = require("./equipAccessory");
const { grantLegendCosmetic, LEGEND_COSMETIC_SKU } = require("./grantLegendCosmetic");
const { mirrorShopItemToPeer } = require("./mirrorShopItem");

module.exports = {
  ...shopCosmetics,
  getShopCatalog,
  getUnownedAccessoryPool,
  purchaseShopItem,
  ShopPurchaseError,
  equipAccessory,
  AccessoryEquipError,
  grantLegendCosmetic,
  LEGEND_COSMETIC_SKU,
  mirrorShopItemToPeer,
};
