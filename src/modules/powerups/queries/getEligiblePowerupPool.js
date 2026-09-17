const { PowerupShopItem } = require("../models/powerupShopItem");
const { isPowerupVisibleToClient } = require("../constants/powerupGating");
const { powerupRequiresGold } = require("../constants/premiumPowerups");

// The daily-box display pool is the shop catalog as this client sees it
// (`active` + `testOnly` per release channel), filtered by the same
// isPowerupVisibleToClient predicate the shop catalog uses. The eligible pool
// is then narrowed by request-scoped policy: Gold users can win all displayed
// powerups, while non-Gold users cannot win items marked requiresGold. Keeping
// these pools separate lets the client show premium decoys without allowing
// them to affect server-side selection or odds.
// Unlike accessories there is no "owned" gate — powerups are re-buyable, so a
// user can always win another one of any type.
async function getPowerupPools({
  channel = "prod",
  supportsJammer = false,
  supportsPowerups2 = false,
  supportsPowerups3 = false,
  supportsPowerups4 = false,
  supportsPowerups5 = false,
  isGoldMember = true,
  powerupShopItemModel = PowerupShopItem,
} = {}) {
  const items = await powerupShopItemModel.findActive({ channel });
  const displayPool = items.filter((item) =>
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
  const eligiblePool = isGoldMember
    ? displayPool
    : displayPool.filter((item) => !powerupRequiresGold(item.powerupType));
  return { displayPool, eligiblePool };
}

async function getEligiblePowerupPool(options = {}) {
  const { eligiblePool } = await getPowerupPools(options);
  return eligiblePool;
}

async function getPowerupDisplayPool(options = {}) {
  const { displayPool } = await getPowerupPools(options);
  return displayPool;
}

module.exports = {
  getPowerupPools,
  getEligiblePowerupPool,
  getPowerupDisplayPool,
};
