const { User } = require("../../users");
const { PowerupShopItem } = require("../models/powerupShopItem");
const { UserPowerupItem } = require("../models/userPowerupItem");
const { PowerupCopy } = require("../models/powerupCopy");
const {
  POWERUPS2_GATED_TYPES,
  POWERUPS3_GATED_TYPES,
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
  const powerupCopyModel = deps.PowerupCopy || PowerupCopy;

  return async function getPowerupShopCatalog(
    userId,
    {
      channel = "prod",
      supportsJammer = false,
      supportsPowerups2 = false,
      supportsPowerups3 = false,
    } = {}
  ) {
    const [coins, items, inventory, copyRows] = await Promise.all([
      userModel.findCoins(userId),
      powerupShopItemModel.findActive({ channel }),
      userPowerupItemModel.findManyByUser(userId),
      // §9.5.2: name/description are now served from the copy catalog. The
      // RESPONSE SHAPE is unchanged — old clients read the same two fields — but
      // PowerupShopItem.name/.description stop being the source of truth. Read
      // defensively: a missing/empty copy table falls back to the shop row, so a
      // half-deployed environment never serves blank strings.
      typeof powerupCopyModel.findAll === "function"
        ? powerupCopyModel.findAll().catch(() => [])
        : Promise.resolve([]),
    ]);

    const copyByType = new Map();
    for (const row of copyRows || []) {
      copyByType.set(row.powerupType, row);
    }

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
      // Leech (moved from powerups2), Hitchhike and Quick Rinse are gated behind
      // `powerups3`. This is VISIBILITY only and is independent of the row's
      // `testOnly` flag, which PowerupShopItem.findActive already applies as a
      // release-CHANNEL gate — the two gates are deliberately layered (§9.2).
      if (!supportsPowerups3 && POWERUPS3_GATED_TYPES.includes(item.powerupType)) {
        return false;
      }
      return true;
    });

    return {
      coins: coins ?? 0,
      items: visibleItems.map((item) => ({
        sku: item.sku,
        name: copyByType.get(item.powerupType)?.name || item.name,
        description:
          copyByType.get(item.powerupType)?.description ?? item.description,
        priceCoins: item.priceCoins,
        powerupType: item.powerupType,
        ownedQuantity: ownedByType[item.powerupType] ?? 0,
      })),
    };
  };
}

const getPowerupShopCatalog = buildGetPowerupShopCatalog();

module.exports = { buildGetPowerupShopCatalog, getPowerupShopCatalog };
