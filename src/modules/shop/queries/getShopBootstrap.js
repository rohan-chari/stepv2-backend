const { prisma: defaultPrisma } = require("../../../db");
const { getShopCatalog: defaultGetShopCatalog } = require("../../cosmetics");
const {
  getPowerupShopCatalog: defaultGetPowerupShopCatalog,
  getPowerupInventory: defaultGetPowerupInventory,
} = require("../../powerups");
const {
  buildAdUnlockBlock: defaultBuildAdUnlockBlock,
} = require("../../economy/services/adUnlockPolicy");

function buildGetShopBootstrap(dependencies = {}) {
  const prisma = dependencies.prisma || defaultPrisma;
  const getShopCatalog =
    dependencies.getShopCatalog || defaultGetShopCatalog;
  const getPowerupShopCatalog =
    dependencies.getPowerupShopCatalog || defaultGetPowerupShopCatalog;
  const getPowerupInventory =
    dependencies.getPowerupInventory || defaultGetPowerupInventory;
  const buildAdUnlockBlock =
    dependencies.buildAdUnlockBlock || defaultBuildAdUnlockBlock;

  async function withAdUnlock(promise, userId, localDate) {
    const result = await promise;
    try {
      result.adUnlock = await buildAdUnlockBlock(prisma, userId, { localDate });
    } catch {}
    return result;
  }

  return async function getShopBootstrap({
    userId,
    localDate,
    channel,
    supportsCharacters,
    supportsRemoteAssets,
    supportsJammer,
    supportsPowerups2,
    supportsPowerups3,
    supportsPowerups4,
    supportsPowerups5,
  }) {
    const [cosmetics, powerups, inventory] = await Promise.allSettled([
      withAdUnlock(
        getShopCatalog(userId, {
          channel,
          supportsCharacters,
          supportsRemoteAssets,
        }),
        userId,
        localDate
      ),
      withAdUnlock(
        getPowerupShopCatalog(userId, {
          channel,
          supportsJammer,
          supportsPowerups2,
          supportsPowerups3,
          supportsPowerups4,
          supportsPowerups5,
          supportsRemoteAssets,
        }),
        userId,
        localDate
      ),
      getPowerupInventory(userId, supportsPowerups4),
    ]);
    if (cosmetics.status === "rejected") throw cosmetics.reason;
    return {
      contract: "shop-bootstrap-v1",
      cosmetics: cosmetics.value,
      resolved: {
        powerups: powerups.status === "fulfilled",
        inventory: inventory.status === "fulfilled",
      },
      powerups: powerups.status === "fulfilled" ? powerups.value : null,
      inventory: inventory.status === "fulfilled" ? inventory.value : null,
    };
  };
}

const getShopBootstrap = buildGetShopBootstrap();

module.exports = { buildGetShopBootstrap, getShopBootstrap };
