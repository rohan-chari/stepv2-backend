const { prisma } = require("../../db");
const {
  buildEquipmentMap,
  serializeShopItem,
  CHARACTER_SLOT,
} = require("./shopCosmetics");
const { testOnlyFilter } = require("../../shared/middleware/releaseChannel");
const derivedCache = require("../../shared/cache/derivedCache");
const cacheKeys = require("../../shared/cache/cacheKeys");
const { appSettings } = require("../../shared/config/appSettings");

const CATALOG_TTL_SECONDS = 60;

// C1 (spec §5 Phase B). ONLY the `shop_items` read is cached — that is the
// query responsible for the 912k sequential scans in §1, and it is the only one
// of the four below that is not per-user. `coins`, `ownedItemIds` and
// `equipped` are read from Postgres on every request exactly as before, so no
// viewer can ever be served another viewer's ownership state.
//
// The cache key carries the channel + capability variants because the row set
// itself is filtered by them (testOnly, CHARACTER slot, remote assetVersion) —
// a single shared key would leak a TestFlight-only item to a prod build.
async function loadCatalogItems({ channel, supportsCharacters, supportsRemoteAssets }) {
  return prisma.shopItem.findMany({
    where: {
      active: true,
      earnOnly: false,
      ...testOnlyFilter(channel),
      // Clients that never declared `characters` support (every binary that
      // predates the feature) must not see CHARACTER items at all — they
      // would render them as HEAD accessories and could buy an animal they
      // can't display.
      ...(supportsCharacters ? {} : { slot: { not: CHARACTER_SLOT } }),
      // Same reasoning for CDN-served art: a binary that never declared
      // `remote_assets` support has no way to download or draw a remote PNG,
      // so it must not see (or be able to buy) an item whose art is remote.
      // Items with a NULL assetVersion are bundled and stay visible to
      // everyone — which is every item that exists today, so this filter is a
      // no-op until the first remote item is created.
      ...(supportsRemoteAssets ? {} : { assetVersion: null }),
    },
    orderBy: [{ sortOrder: "asc" }, { name: "asc" }],
  });
}

async function getShopCatalog(
  userId,
  {
    channel = "prod",
    supportsCharacters = false,
    supportsRemoteAssets = false,
  } = {}
) {
  const variant = { channel, supportsCharacters, supportsRemoteAssets };
  let enabled = false;
  try {
    enabled =
      (await appSettings.getFlag("redisCacheCatalogsEnabled")) === true;
  } catch {
    enabled = false;
  }

  const [user, items, owned, equippedAccessories] = await Promise.all([
    prisma.user.findUnique({
      where: { id: userId },
      select: { coins: true },
    }),
    derivedCache.cachedRead({
      key: cacheKeys.shopCatalog(variant),
      prefix: cacheKeys.PREFIX.SHOP_CATALOG,
      ttlSeconds: CATALOG_TTL_SECONDS,
      enabled,
      load: () => loadCatalogItems(variant),
    }),
    prisma.userShopItem.findMany({
      where: { userId },
      select: { shopItemId: true },
    }),
    prisma.userEquippedAccessory.findMany({
      where: { userId },
      include: { shopItem: true },
    }),
  ]);

  const ownedItemIds = owned.map((entry) => entry.shopItemId);
  const ownedItemIdSet = new Set(ownedItemIds);
  // On the prod channel, never surface a still-hidden item the user equipped
  // while on a TestFlight build — otherwise it would render on their prod
  // avatar (and reference an asset their prod binary may not bundle).
  const visibleEquipped = equippedAccessories.filter(
    (entry) =>
      (channel === "testflight" || !entry.shopItem?.testOnly) &&
      // Same reasoning as the catalog filter: a CHARACTER row equipped from a
      // characters-capable build must not reach an old binary's `equipped`
      // map, or it renders as a floating accessory on the capybara.
      (supportsCharacters || entry.shopItem?.slot !== CHARACTER_SLOT)
  );
  const equipped = buildEquipmentMap(visibleEquipped);
  const equippedItemIdSet = new Set(
    Object.values(equipped).map((item) => item.id)
  );

  return {
    coins: user?.coins ?? 0,
    ownedItemIds,
    equipped,
    items: items.map((item) =>
      serializeShopItem(item, {
        owned: ownedItemIdSet.has(item.id),
        equipped: equippedItemIdSet.has(item.id),
      })
    ),
  };
}

module.exports = { getShopCatalog };
