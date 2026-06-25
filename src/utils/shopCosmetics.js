const ACCESSORY_SLOTS = ["HEAD", "FACE", "NECK", "BACK", "FEET"];

// Include `bobble` in the payload ONLY when the row actually carries it (i.e. the
// feeding query selected the column). If a query forgot to select it, we omit the
// key entirely rather than send `false` — that lets the client fall back to its
// historical slot-based bob (HEAD/FACE/NECK), avoiding a silent regression where a
// hat stops bobbing just because one query wasn't updated.
function bobbleField(item) {
  return typeof item.bobble === "boolean" ? { bobble: item.bobble } : {};
}

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
    ...bobbleField(item),
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
    ...bobbleField(item),
  };
}

function buildEquipmentMap(equippedAccessories = []) {
  return equippedAccessories.reduce((equipment, accessory) => {
    equipment[accessory.slot] = serializeEquippedAccessory(accessory);
    return equipment;
  }, {});
}

// Accessories shown on OTHER users' avatars across social/competitive surfaces
// (races, leaderboard, ranked, friends, home race card). Test-only items are
// always stripped here so a prod client never receives — and never tries to
// render — a cosmetic it doesn't bundle, no matter who equipped it. The
// viewer's OWN equipped preview goes through buildEquipmentMap in
// getShopCatalog, which is channel-gated separately so testers still see their
// test items on their own capybara. Requires `testOnly` in the shopItem select
// on every feeding query (else it reads undefined and never filters).
function buildAccessoriesList(user) {
  const equipped = (user?.equippedAccessories || []).filter(
    (accessory) => !accessory.shopItem?.testOnly
  );
  return Object.values(buildEquipmentMap(equipped));
}

module.exports = {
  ACCESSORY_SLOTS,
  serializeShopItem,
  serializeEquippedAccessory,
  buildEquipmentMap,
  buildAccessoriesList,
};
