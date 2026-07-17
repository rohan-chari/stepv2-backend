const { PowerupShopItem } = require("../models/powerupShopItem");
const { POWERUPS2_GATED_TYPES } = require("../constants/powerupGating");

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
} = {}) {
  const items = await powerupShopItemModel.findActive({ channel });
  return items.filter((item) => {
    // Signal Jammer stays gated behind the `jammer` client-feature.
    if (!supportsJammer && item.powerupType === "SIGNAL_JAMMER") return false;
    // Leech + X-Ray are store-only utility/attack powerups: never awarded from
    // the daily box (and always excluded so a spinpowerups-but-not-powerups2
    // client can't win a type it can't render/use).
    if (POWERUPS2_GATED_TYPES.includes(item.powerupType)) return false;
    return true;
  });
}

module.exports = { getEligiblePowerupPool };
