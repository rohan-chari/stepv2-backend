const { User } = require("../models/user");
const { PowerupShopItem } = require("../models/powerupShopItem");
const { UserPowerupItem } = require("../models/userPowerupItem");
const {
  POWERUPS2_GATED_TYPES,
  isImposterDisabledForCatalog,
} = require("../constants/powerupGating");

// GET /shop/powerups — active coin-purchasable powerups, the user's coin
// balance, and how many of each type the user already owns. Powerups are
// re-buyable, so (unlike cosmetics) there is no "owned" gate — `ownedQuantity`
// just reflects the inventory count.
function buildGetPowerupShopCatalog(deps = {}) {
  const userModel = deps.User || User;
  const powerupShopItemModel = deps.PowerupShopItem || PowerupShopItem;
  const userPowerupItemModel = deps.UserPowerupItem || UserPowerupItem;

  return async function getPowerupShopCatalog(
    userId,
    { channel = "prod", supportsJammer = false, supportsPowerups2 = false } = {}
  ) {
    const [coins, items, inventory] = await Promise.all([
      userModel.findCoins(userId),
      powerupShopItemModel.findActive({ channel }),
      userPowerupItemModel.findManyByUser(userId),
    ]);

    const ownedByType = {};
    for (const row of inventory) {
      ownedByType[row.powerupType] = row.quantity ?? 0;
    }

    // Layered gating (all additive — every other powerup is returned to all
    // clients):
    //   * IMPOSTER is DISABLED going forward: filtered out unconditionally so no
    //     app version — old or new — is offered it anymore (Item 3). Held/owned
    //     copies are untouched; re-enable is a single env flip (IMPOSTER_ENABLED).
    //   * Signal Jammer is gated behind the `jammer` client-feature: old binaries
    //     that don't advertise it never see it (they can't render/target it).
    //   * Leech + X-Ray (DEFENSE_SCAN) are gated behind the `powerups2` feature:
    //     old binaries never see them until the carrying app build rolls out.
    const visibleItems = items.filter((item) => {
      if (isImposterDisabledForCatalog(item.powerupType)) return false;
      if (!supportsJammer && item.powerupType === "SIGNAL_JAMMER") return false;
      if (!supportsPowerups2 && POWERUPS2_GATED_TYPES.includes(item.powerupType)) {
        return false;
      }
      return true;
    });

    return {
      coins: coins ?? 0,
      items: visibleItems.map((item) => ({
        sku: item.sku,
        name: item.name,
        description: item.description,
        priceCoins: item.priceCoins,
        powerupType: item.powerupType,
        ownedQuantity: ownedByType[item.powerupType] ?? 0,
      })),
    };
  };
}

const getPowerupShopCatalog = buildGetPowerupShopCatalog();

module.exports = { buildGetPowerupShopCatalog, getPowerupShopCatalog };
