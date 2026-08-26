const { PowerupShopItem } = require("../models/powerupShopItem");
const { isPowerupVisibleToClient } = require("../constants/powerupGating");

// The daily-box powerup prize pool IS the shop catalog as this client sees it
// (2026-07-28 simplification): findActive (`active` + `testOnly` per release
// channel) filtered by the SAME isPowerupVisibleToClient predicate the shop
// catalog uses. One rule — visible in the shop ⟺ winnable from the daily spin.
// The old `dailyBoxExcludedTypes` balance-config list is gone; it was the
// second authority that let the spinner drift from the store (a stale stored
// copy paid out COIN_FLIP and friends). Hiding an item from the store now
// removes it from the spin in the same breath.
// Unlike accessories there is no "owned" gate — powerups are re-buyable, so a
// user can always win another one of any type.
async function getEligiblePowerupPool({
  channel = "prod",
  supportsJammer = false,
  supportsPowerups2 = false,
  supportsPowerups3 = false,
  supportsPowerups4 = false,
  supportsPowerups5 = false,
  powerupShopItemModel = PowerupShopItem,
} = {}) {
  const items = await powerupShopItemModel.findActive({ channel });
  return items.filter((item) =>
    // Old model doubles and mixed-version row projections do not carry the
    // additive column. Only an explicit false opts an item out.
    item.dailyRewardEligible !== false &&
    isPowerupVisibleToClient(item.powerupType, {
      supportsJammer,
      supportsPowerups2,
      supportsPowerups3,
      supportsPowerups4,
      supportsPowerups5,
    })
  );
}

module.exports = { getEligiblePowerupPool };
