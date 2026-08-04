const { User } = require("../../users");
const { PowerupShopItem } = require("../models/powerupShopItem");
const { UserPowerupItem } = require("../models/userPowerupItem");
const { PowerupCopy } = require("../models/powerupCopy");
const { isPowerupVisibleToClient } = require("../constants/powerupGating");
const { categoryForPowerup } = require("../constants/powerupCategories");
const { balanceConfig } = require("../../economy/balanceConfig");
const {
  DEFAULT_CONFIG: BALANCE_DEFAULT_CONFIG,
} = require("../../economy/balanceConfig.defaults");
const { powerupAssetUrl } = require("../../../shared/lib/remoteAssets");

// See shopCosmetics.assetVersionFields — additive, and absent for bundled art.
function powerupAssetFields(item) {
  const url = powerupAssetUrl(item.powerupType, item.assetVersion);
  if (!url) return {};
  return { assetVersion: item.assetVersion, assetUrl: url };
}

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
      supportsPowerups4 = false,
      supportsPowerups5 = false,
      supportsRemoteAssets = false,
    } = {}
  ) {
    const [coins, items, inventory, copyRows] = await Promise.all([
      userModel.findCoins(userId),
      powerupShopItemModel.findActive({ channel, supportsRemoteAssets }),
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

    // Item 9: canonical rarity per type, read from the live balance config (the
    // same source powerupUpgrades uses). Read defensively — a not-yet-loaded
    // config falls back to the shipped defaults so a rarity is always present.
    let rarityByType;
    try {
      rarityByType =
        (balanceConfig.getConfigSync && balanceConfig.getConfigSync().rarityByType) ||
        BALANCE_DEFAULT_CONFIG.rarityByType;
    } catch {
      rarityByType = BALANCE_DEFAULT_CONFIG.rarityByType;
    }

    // Client-feature gating (Imposter kill switch, jammer, powerups2–5) lives
    // in the shared isPowerupVisibleToClient predicate — the SAME rule the
    // daily-spin prize pool applies, so the shop and the spinner can never
    // drift. VISIBILITY only, layered on top of the row's testOnly
    // release-channel gate which findActive already applied (§9.2).
    const visibleItems = items.filter((item) =>
      isPowerupVisibleToClient(item.powerupType, {
        supportsJammer,
        supportsPowerups2,
        supportsPowerups3,
        supportsPowerups4,
        supportsPowerups5,
      })
    );

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
        // Item 9 — additive. Old clients ignore both; the frontend defaults a
        // missing category to "utility" and a missing rarity to COMMON.
        category: categoryForPowerup(item.powerupType),
        rarity: rarityByType[item.powerupType] ?? "COMMON",
        // CDN-served icon. Omitted entirely for bundled powerups (every row
        // today), so the payload old clients parse is byte-identical.
        ...powerupAssetFields(item),
      })),
    };
  };
}

const getPowerupShopCatalog = buildGetPowerupShopCatalog();

module.exports = { buildGetPowerupShopCatalog, getPowerupShopCatalog };
