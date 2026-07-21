const { PowerupShopItem } = require("../models/powerupShopItem");
const { balanceConfig } = require("../../economy/balanceConfig");

// Active shop powerups a daily-box RARE roll may award, and the preview shown
// on the reel for spinpowerups-capable clients. Mirrors getUnownedAccessoryPool
// for the powerup catalog:
//   - `testOnly` items are hidden from the prod channel (PowerupShopItem.
//     findActive applies the release-channel filter) — prod builds don't bundle
//     their assets.
//   - the Signal Jammer is gated behind the `jammer` client-feature, same as
//     the powerup shop catalog (getPowerupShopCatalog): a client that can't
//     render/target it must never win one.
// Unlike accessories there is no "owned" gate — powerups are re-buyable, so a
// user can always win another one of any type.
async function getEligiblePowerupPool({
  channel = "prod",
  supportsJammer = false,
  powerupShopItemModel = PowerupShopItem,
  config = null,
} = {}) {
  const items = await powerupShopItemModel.findActive({ channel });
  // D13: the balance config is now the SINGLE authority on daily-box exclusion.
  // This used to consult the hardcoded POWERUPS2/3_GATED_TYPES lists in
  // constants/powerupGating.js — a second authority kept in step by hand, which
  // is the exact class of bug this build removes. Those lists still exist and
  // are still correct, but ONLY for client-feature gating (which binaries may
  // SEE a type in the shop); that is a frozen-client compatibility concern and
  // must not become admin-editable.
  //
  // Note this reads `dailyBoxExcludedTypes`, NOT `storeOnlyTypes`. The latter
  // governs in-race MYSTERY box drops (enforced structurally by dropPool) and
  // is a strictly larger set: Imposter, Rainstorm and Signal Jammer never roll
  // from a mystery box but ARE winnable daily-box prizes. See the defaults file.
  const excluded =
    (config || balanceConfig.getConfigSync()).dailyBoxExcludedTypes || [];
  return items.filter((item) => {
    // Signal Jammer stays gated behind the `jammer` client-feature.
    if (!supportsJammer && item.powerupType === "SIGNAL_JAMMER") return false;
    if (excluded.includes(item.powerupType)) return false;
    return true;
  });
}

module.exports = { getEligiblePowerupPool };
