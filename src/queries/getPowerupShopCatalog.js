const { User } = require("../models/user");
const { PowerupShopItem } = require("../models/powerupShopItem");
const { UserPowerupItem } = require("../models/userPowerupItem");

// GET /shop/powerups — active coin-purchasable powerups, the user's coin
// balance, and how many of each type the user already owns. Powerups are
// re-buyable, so (unlike cosmetics) there is no "owned" gate — `ownedQuantity`
// just reflects the inventory count.
function buildGetPowerupShopCatalog(deps = {}) {
  const userModel = deps.User || User;
  const powerupShopItemModel = deps.PowerupShopItem || PowerupShopItem;
  const userPowerupItemModel = deps.UserPowerupItem || UserPowerupItem;

  return async function getPowerupShopCatalog(userId) {
    const [coins, items, inventory] = await Promise.all([
      userModel.findCoins(userId),
      powerupShopItemModel.findActive(),
      userPowerupItemModel.findManyByUser(userId),
    ]);

    const ownedByType = {};
    for (const row of inventory) {
      ownedByType[row.powerupType] = row.quantity ?? 0;
    }

    return {
      coins: coins ?? 0,
      items: items.map((item) => ({
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
