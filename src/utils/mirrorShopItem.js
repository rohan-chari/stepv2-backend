const { getPeerPrisma } = require("../peerDb");

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

  // Mirror every editable/displayable field (omit the env-local id/createdAt).
  const fields = {
    name: item.name,
    description: item.description ?? null,
    slot: item.slot,
    priceCoins: item.priceCoins,
    assetKey: item.assetKey,
    renderMetadata: item.renderMetadata ?? null,
    active: item.active,
    testOnly: item.testOnly,
    sortOrder: item.sortOrder,
  };

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

module.exports = { mirrorShopItemToPeer };
