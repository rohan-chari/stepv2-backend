const { shopItemAssetUrl } = require("../../shared/lib/remoteAssets");

const ACCESSORY_SLOTS = ["HEAD", "FACE", "NECK", "BACK", "FEET", "CHARACTER"];

// Base body slot. Items in this slot must NEVER appear in the accessories /
// equippedAccessories arrays or in a catalog/equipped payload for a client
// that hasn't declared `characters` support: old app binaries render every
// array entry as an accessory anchored to the capybara (unknown slots fall
// back to HEAD), so a leaked CHARACTER item shows up as a floating corgi hat.
// Character state travels only via the separate `animal` field, which old
// clients ignore entirely (they just show the default capybara).
const CHARACTER_SLOT = "CHARACTER";

// Include `bobble` in the payload ONLY when the row actually carries it (i.e. the
// feeding query selected the column). If a query forgot to select it, we omit the
// key entirely rather than send `false` — that lets the client fall back to its
// historical slot-based bob (HEAD/FACE/NECK), avoiding a silent regression where a
// hat stops bobbing just because one query wasn't updated.
function bobbleField(item) {
  return typeof item.bobble === "boolean" ? { bobble: item.bobble } : {};
}

// CDN-served art, additive and OMITTED ENTIRELY for bundled items (the vast
// majority, and every row that predates the feature) so their payload stays
// byte-identical to what shipped binaries already parse. A remote item carries
// both the raw version (cache key) and the fully-built URL, so the client never
// has to know the path scheme. Same defensive shape as `bobble`: if a feeding
// query didn't select the column we emit nothing rather than a wrong `null`.
function assetVersionFields(item) {
  const url = shopItemAssetUrl(item);
  if (!url) return {};
  return { assetVersion: item.assetVersion, assetUrl: url };
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
    ...assetVersionFields(item),
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
    ...assetVersionFields(item),
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
function buildAccessoriesList(user, channel = "prod") {
  const includeTestOnly = channel === "testflight";
  const equipped = (user?.equippedAccessories || []).filter(
    (accessory) =>
      (includeTestOnly || !accessory.shopItem?.testOnly) &&
      accessory.shopItem?.slot !== CHARACTER_SLOT
  );
  return Object.values(buildEquipmentMap(equipped));
}

// The user's equipped base animal for OTHER-user surfaces, e.g. "corgi_puppy",
// or null for the default capybara. Emitted as a sibling `animal` field next
// to the accessories array; old clients ignore the extra key. Test-only
// characters are stripped for the same reason as test-only accessories above
// (prod clients don't bundle the asset).
// Batch 2026-07-26, item 8: `channel` makes the testOnly strip RELEASE-CHANNEL
// aware. `corgi_puppy`/`turtle` are testOnly:true, so before this a TestFlight
// turtle user was served `animal: null` even for THEIR OWN row on every race
// surface — the reported "I can't see my character in the race track" bug —
// while the shop and home hero (which are already channel-gated) showed it.
// "prod" stays the safe default: a shipped binary never receives an assetKey it
// does not bundle. Callers thread req.releaseChannel; omitting it is unchanged
// prod behaviour.
function equippedAnimal(user, channel = "prod") {
  const includeTestOnly = channel === "testflight";
  const character = (user?.equippedAccessories || []).find(
    (accessory) =>
      accessory.shopItem?.slot === CHARACTER_SLOT &&
      (includeTestOnly || !accessory.shopItem?.testOnly)
  );
  return character ? character.shopItem.assetKey : null;
}

// Full character-aware presentation of a user for OTHER-user surfaces.
// Clients declare `X-Client-Features: characters` when they can draw
// purchasable base characters. A viewer WITHOUT that capability must see a
// character-equipped user as a NAKED default capybara — no `animal` (their
// binary either ignores it or lacks the asset) and no accessories (gear is
// tuned per-animal; drawn on the wrong body it misrepresents the user).
// Users with no character equipped are presented identically to everyone.
function characterPresentation(user, supportsCharacters = false, channel = "prod") {
  const animal = equippedAnimal(user, channel);
  if (animal && !supportsCharacters) {
    return { animal: null, accessories: [] };
  }
  return { animal, accessories: buildAccessoriesList(user, channel) };
}

module.exports = {
  ACCESSORY_SLOTS,
  assetVersionFields,
  CHARACTER_SLOT,
  serializeShopItem,
  serializeEquippedAccessory,
  buildEquipmentMap,
  buildAccessoriesList,
  equippedAnimal,
  characterPresentation,
};
