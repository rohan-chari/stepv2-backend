const manifest = require("../../../data/character-wardrobe-retirements.json");
// SKUs are cross-environment content identity. IDs differ on peer clones.
const retiredSkus = new Set(
  manifest.items.filter((i) => i.retired === true).map((i) => i.sku),
);
function isRetiredCosmetic(sku) {
  return retiredSkus.has(sku);
}
function preserveRetirement(item) {
  return isRetiredCosmetic(item.sku) ? { ...item, active: false } : item;
}
module.exports = { isRetiredCosmetic, preserveRetirement };
