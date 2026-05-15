const ACCESSORY_SLOTS = ["HEAD", "FACE", "NECK", "BACK"];

function serializeShopItem(item, extras = {}) {
  return {
    id: item.id,
    sku: item.sku,
    name: item.name,
    description: item.description,
    slot: item.slot,
    priceCoins: item.priceCoins,
    assetKey: item.assetKey,
    renderMetadata: item.renderMetadata,
    ...extras,
  };
}

function serializeEquippedAccessory(equippedAccessory) {
  const item = equippedAccessory.shopItem;
  return {
    id: item.id,
    sku: item.sku,
    name: item.name,
    slot: item.slot,
    assetKey: item.assetKey,
    renderMetadata: item.renderMetadata,
  };
}

function buildEquipmentMap(equippedAccessories = []) {
  return equippedAccessories.reduce((equipment, accessory) => {
    equipment[accessory.slot] = serializeEquippedAccessory(accessory);
    return equipment;
  }, {});
}

function buildAccessoriesList(user) {
  return Object.values(buildEquipmentMap(user?.equippedAccessories || []));
}

module.exports = {
  ACCESSORY_SLOTS,
  serializeShopItem,
  serializeEquippedAccessory,
  buildEquipmentMap,
  buildAccessoriesList,
};
