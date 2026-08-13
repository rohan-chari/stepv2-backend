const { getPeerPrisma } = require("../../peerDb");

// Every editable/displayable column (the env-local id/createdAt are omitted).
// KEEP IN SYNC with scripts/cosmetics-sync-peer.js COMPARED_FIELDS and
// scripts/cosmetics-clone.js CLONED_FIELDS — a column added to the schema but
// forgotten in one of these three lists is the known "peer drift" incident:
// the field silently stops mirroring and prod/staging diverge.
const MIRRORED_SHOP_ITEM_FIELDS = [
  "name",
  "description",
  "slot",
  "priceCoins",
  "assetKey",
  "renderMetadata",
  "compatibility",
  "active",
  "testOnly",
  "earnOnly",
  "bobble",
  "sortOrder",
  "assetVersion",
  "remoteOnly",
];

// Mirror a cosmetic shop item to the peer database (matched by sku, since the
// row's uuid differs across environments) so prod and staging stay consistent
// no matter which environment the admin accessory editor is pointed at.
//
// Best-effort by design: it never throws and never blocks the primary write.
// If there is no peer configured (PEER_DATABASE_URL unset) it is a clean no-op.
// Returns a small status object so the editor can surface sync state.
async function mirrorShopItemToPeer(item) {
  const peer = getPeerPrisma();
  if (!peer) {
    return { attempted: false, ok: false, reason: "no_peer_configured" };
  }

  const fields = {};
  for (const key of MIRRORED_SHOP_ITEM_FIELDS) {
    if (key === "description" || key === "renderMetadata" || key === "compatibility") {
      fields[key] = item[key] ?? null;
    } else if (key === "earnOnly" || key === "bobble") {
      fields[key] = item[key] ?? false;
    } else if (key === "assetVersion") {
      fields[key] = item[key] ?? null;
    } else if (key === "remoteOnly") {
      fields[key] = item[key] ?? false;
    } else {
      fields[key] = item[key];
    }
  }

  try {
    await peer.shopItem.upsert({
      where: { sku: item.sku },
      update: fields,
      create: { sku: item.sku, ...fields },
    });
    return { attempted: true, ok: true };
  } catch (error) {
    console.error(`Peer mirror failed for sku=${item.sku}:`, error.message);
    return { attempted: true, ok: false, reason: error.message };
  }
}

module.exports = { mirrorShopItemToPeer, MIRRORED_SHOP_ITEM_FIELDS };
