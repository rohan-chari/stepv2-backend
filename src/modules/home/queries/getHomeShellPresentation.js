const { prisma: defaultPrisma } = require("../../../db");
const { testOnlyFilter } = require("../../../shared/middleware/releaseChannel");
const {
  buildEquipmentMap,
  CHARACTER_SLOT,
  serializeShopItem,
} = require("../../cosmetics");
const {
  homeLaunchAuxiliaryBatch: defaultHomeLaunchAuxiliaryBatch,
} = require("../services/homeLaunchAuxiliaryBatch");

function buildGetHomeShellPresentation(dependencies = {}) {
  const prisma = dependencies.prisma || defaultPrisma;
  const launchBatch = dependencies.homeLaunchAuxiliaryBatch ||
    (prisma === defaultPrisma ? defaultHomeLaunchAuxiliaryBatch : null);
  return async function getHomeShellPresentation({
    userId,
    coins: authenticatedCoins = null,
    channel = "prod",
    supportsCharacters = false,
    supportsRemoteAssets = false,
  }) {
    const [user, equippedRows, capeRow] = await Promise.all([
      Number.isInteger(authenticatedCoins)
        ? Promise.resolve({ coins: authenticatedCoins })
        : prisma.user.findUnique({
            where: { id: userId },
            select: { coins: true },
          }),
      launchBatch
        ? launchBatch.loadEquipment({ prisma, userId })
        : prisma.userEquippedAccessory.findMany({
            where: { userId },
            include: { shopItem: true },
          }),
      (() => {
        const where = {
          active: true,
          earnOnly: false,
          assetKey: "cape",
          ...testOnlyFilter(channel),
          ...(supportsCharacters ? {} : { slot: { not: CHARACTER_SLOT } }),
          ...(supportsRemoteAssets ? {} : { remoteOnly: false }),
        };
        const orderBy = [{ sortOrder: "asc" }, { name: "asc" }];
        return launchBatch
          ? launchBatch.loadCape({
              prisma,
              cacheKey: `${channel}:${supportsCharacters}:${supportsRemoteAssets}`,
              where,
              orderBy,
            })
          : prisma.shopItem.findFirst({ where, orderBy });
      })(),
    ]);
    const visibleEquipped = equippedRows.filter(
      (entry) =>
        (channel === "testflight" || !entry.shopItem?.testOnly) &&
        (supportsCharacters || entry.shopItem?.slot !== CHARACTER_SLOT) &&
        (supportsRemoteAssets || !entry.shopItem?.remoteOnly)
    );
    return {
      coins: user?.coins ?? 0,
      equipped: buildEquipmentMap(visibleEquipped),
      cape: capeRow ? serializeShopItem(capeRow) : null,
    };
  };
}

const getHomeShellPresentation = buildGetHomeShellPresentation();

module.exports = {
  buildGetHomeShellPresentation,
  getHomeShellPresentation,
};
