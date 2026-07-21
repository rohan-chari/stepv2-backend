const assert = require("node:assert/strict");
const test = require("node:test");

const {
  buildGetPowerupInventory,
} = require("../../src/modules/powerups/queries/getPowerupInventory");
const {
  buildGetPowerupShopCatalog,
} = require("../../src/modules/powerups/queries/getPowerupShopCatalog");

// ---------------------------------------------------------------------------
// GET /powerups/inventory → the user's UserPowerupItem rows (powerupType +
// quantity). GET /shop/powerups → active PowerupShopItems + coin balance +
// per-type owned quantity.
//
// Written from the Prisma schema + spec, NOT by mirroring implementation.
// ---------------------------------------------------------------------------

function makeInventoryDeps(rows) {
  return {
    UserPowerupItem: {
      async findManyByUser(userId) {
        return rows.filter((r) => r.userId === userId);
      },
    },
  };
}

test("inventory returns correct per-type quantities", async () => {
  const deps = makeInventoryDeps([
    { userId: "user-1", powerupType: "IMPOSTER", quantity: 3 },
    { userId: "user-1", powerupType: "MIRROR", quantity: 1 },
    { userId: "user-2", powerupType: "IMPOSTER", quantity: 99 },
  ]);
  const getInventory = buildGetPowerupInventory(deps);

  const result = await getInventory("user-1");

  const byType = Object.fromEntries(
    result.items.map((i) => [i.powerupType, i.quantity])
  );
  assert.equal(byType.IMPOSTER, 3);
  assert.equal(byType.MIRROR, 1);
  assert.equal(result.items.length, 2, "only this user's rows");
});

test("inventory omits zero-quantity rows", async () => {
  const deps = makeInventoryDeps([
    { userId: "user-1", powerupType: "IMPOSTER", quantity: 0 },
    { userId: "user-1", powerupType: "MIRROR", quantity: 2 },
  ]);
  const getInventory = buildGetPowerupInventory(deps);

  const result = await getInventory("user-1");

  assert.equal(result.items.length, 1);
  assert.equal(result.items[0].powerupType, "MIRROR");
});

test("inventory for a user with nothing returns an empty list", async () => {
  const deps = makeInventoryDeps([]);
  const getInventory = buildGetPowerupInventory(deps);

  const result = await getInventory("user-1");
  assert.deepEqual(result.items, []);
});

// ---------------------------------------------------------------------------

function makeCatalogDeps({ coins, items, inventory }) {
  return {
    User: {
      async findCoins() {
        return coins;
      },
    },
    PowerupShopItem: {
      async findActive() {
        return items;
      },
    },
    UserPowerupItem: {
      async findManyByUser() {
        return inventory;
      },
    },
  };
}

test("powerup catalog lists active items with price + coin balance + owned qty", async () => {
  const deps = makeCatalogDeps({
    coins: 750,
    items: [
      {
        id: "psi-1",
        sku: "POWERUP_IMPOSTER",
        name: "Imposter",
        description: "Swap positions",
        priceCoins: 75,
        powerupType: "IMPOSTER",
      },
    ],
    inventory: [{ powerupType: "IMPOSTER", quantity: 2 }],
  });
  const getCatalog = buildGetPowerupShopCatalog(deps);

  const result = await getCatalog("user-1");

  assert.equal(result.coins, 750);
  assert.equal(result.items.length, 1);
  const item = result.items[0];
  assert.equal(item.sku, "POWERUP_IMPOSTER");
  assert.equal(item.name, "Imposter");
  assert.equal(item.priceCoins, 75);
  assert.equal(item.powerupType, "IMPOSTER");
  assert.equal(item.ownedQuantity, 2, "shows how many the user owns");
});

test("powerup catalog reports ownedQuantity 0 for unowned types", async () => {
  const deps = makeCatalogDeps({
    coins: 0,
    items: [
      {
        id: "psi-1",
        sku: "POWERUP_IMPOSTER",
        name: "Imposter",
        priceCoins: 75,
        powerupType: "IMPOSTER",
      },
    ],
    inventory: [],
  });
  const getCatalog = buildGetPowerupShopCatalog(deps);

  const result = await getCatalog("user-1");
  assert.equal(result.items[0].ownedQuantity, 0);
});
