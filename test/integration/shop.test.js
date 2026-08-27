const assert = require("node:assert/strict");
const { describe, it, before, beforeEach } = require("node:test");

const { cleanDatabase, prisma, request, getSharedServer } = require("./setup");
const { appSettings } = require("../../src/shared/config/appSettings");

let server;
let nextAppleId = 0;

async function createUser(displayName, coins = 0) {
  const appleId = `apple-shop-${++nextAppleId}`;
  const res = await request(server.baseUrl, "POST", "/auth/apple", {
    body: { identityToken: appleId },
  });
  const body = await res.json();

  if (displayName) {
    await request(server.baseUrl, "PUT", "/auth/me/display-name", {
      body: { displayName },
      token: body.sessionToken,
    });
  }

  if (coins > 0) {
    await prisma.user.update({
      where: { id: body.user.id },
      data: { coins },
    });
  }

  return { userId: body.user.id, token: body.sessionToken };
}

async function createShopItem(overrides = {}) {
  return prisma.shopItem.create({
    data: {
      sku: overrides.sku || "straw_hat",
      name: overrides.name || "Straw Hat",
      description: overrides.description || "Sunny race-day style.",
      slot: overrides.slot || "HEAD",
      priceCoins: overrides.priceCoins ?? 75,
      assetKey: overrides.assetKey || "straw_hat",
      renderMetadata: overrides.renderMetadata ?? null,
      active: overrides.active ?? true,
      sortOrder: overrides.sortOrder ?? 10,
    },
  });
}

describe("shop", () => {
  before(async () => {
    server = await getSharedServer();
  });

  beforeEach(async () => {
    await cleanDatabase();
    nextAppleId = 0;
  });

  it("returns catalog items with ownership, equipment, metadata, and coins", async () => {
    const user = await createUser("ShopViewer", 125);
    const item = await createShopItem({
      renderMetadata: { offsetX: -0.015, offsetY: 0.03, rotation: -0.14 },
    });
    await prisma.userShopItem.create({
      data: { userId: user.userId, shopItemId: item.id },
    });
    await prisma.userEquippedAccessory.create({
      data: { userId: user.userId, shopItemId: item.id, slot: "HEAD" },
    });

    const res = await request(server.baseUrl, "GET", "/shop/catalog", {
      token: user.token,
    });

    assert.equal(res.status, 200);
    const body = await res.json();
    assert.equal(body.coins, 125);
    assert.deepEqual(body.ownedItemIds, [item.id]);
    assert.equal(body.equipped.HEAD.id, item.id);
    assert.deepEqual(body.equipped.HEAD.renderMetadata, {
      offsetX: -0.015,
      offsetY: 0.03,
      rotation: -0.14,
    });
    assert.deepEqual(body.items, [
      {
        id: item.id,
        sku: "straw_hat",
        name: "Straw Hat",
        description: "Sunny race-day style.",
        slot: "HEAD",
        priceCoins: 75,
        assetKey: "straw_hat",
        renderMetadata: { offsetX: -0.015, offsetY: 0.03, rotation: -0.14 },
        bobble: false,
        owned: true,
        equipped: true,
      },
    ]);
  });

  it("requires an idempotency key for purchases", async () => {
    const user = await createUser("NoKeyBuyer", 125);
    const item = await createShopItem({
      renderMetadata: { offsetX: -0.015, offsetY: 0.03, rotation: -0.14 },
    });

    const res = await request(
      server.baseUrl,
      "POST",
      `/shop/items/${item.id}/purchase`,
      { token: user.token }
    );

    assert.equal(res.status, 400);
    assert.deepEqual(await res.json(), {
      error: "Idempotency-Key header is required",
    });
  });

  it("purchases an active item once and records the idempotent result", async () => {
    const user = await createUser("ShopBuyer", 125);
    const item = await createShopItem();

    const first = await request(
      server.baseUrl,
      "POST",
      `/shop/items/${item.id}/purchase`,
      {
        token: user.token,
        headers: { "Idempotency-Key": "purchase-key-1" },
      }
    );

    assert.equal(first.status, 200);
    const firstBody = await first.json();
    assert.equal(firstBody.coins, 50);
    assert.equal(firstBody.item.id, item.id);
    assert.equal(firstBody.purchase.idempotent, false);

    const second = await request(
      server.baseUrl,
      "POST",
      `/shop/items/${item.id}/purchase`,
      {
        token: user.token,
        headers: { "Idempotency-Key": "purchase-key-1" },
      }
    );

    assert.equal(second.status, 200);
    const secondBody = await second.json();
    assert.equal(secondBody.coins, 50);
    assert.equal(secondBody.item.id, item.id);
    assert.equal(secondBody.purchase.idempotent, true);

    const freshUser = await prisma.user.findUnique({
      where: { id: user.userId },
    });
    assert.equal(freshUser.coins, 50);

    const ownershipCount = await prisma.userShopItem.count({
      where: { userId: user.userId, shopItemId: item.id },
    });
    assert.equal(ownershipCount, 1);

    const transactions = await prisma.coinTransaction.findMany({
      where: { userId: user.userId, reason: "shop_purchase" },
    });
    assert.equal(transactions.length, 1);
    assert.equal(transactions[0].amount, -75);
  });

  it("unlocks a free item without creating a coin transaction", async () => {
    const user = await createUser("FreeHatBuyer", 0);
    const item = await createShopItem({
      sku: "cowboy_hat",
      name: "Cowboy Hat",
      priceCoins: 0,
      assetKey: "cowboy_hat",
      renderMetadata: { offsetX: -0.015, offsetY: 0.03, rotation: -0.14 },
    });

    const res = await request(
      server.baseUrl,
      "POST",
      `/shop/items/${item.id}/purchase`,
      {
        token: user.token,
        headers: { "Idempotency-Key": "free-hat-key" },
      }
    );

    assert.equal(res.status, 200);
    const body = await res.json();
    assert.equal(body.coins, 0);
    assert.equal(body.purchase.coinsSpent, 0);
    assert.deepEqual(body.item.renderMetadata, {
      offsetX: -0.015,
      offsetY: 0.03,
      rotation: -0.14,
    });

    const transactions = await prisma.coinTransaction.findMany({
      where: { userId: user.userId, reason: "shop_purchase" },
    });
    assert.equal(transactions.length, 0);
  });

  it("rejects idempotency key reuse for a different item", async () => {
    const user = await createUser("KeyReuse", 250);
    const firstItem = await createShopItem({ sku: "straw_hat" });
    const secondItem = await createShopItem({
      sku: "visor",
      name: "Visor",
      assetKey: "visor",
    });

    const first = await request(
      server.baseUrl,
      "POST",
      `/shop/items/${firstItem.id}/purchase`,
      {
        token: user.token,
        headers: { "Idempotency-Key": "same-key" },
      }
    );
    assert.equal(first.status, 200);

    const second = await request(
      server.baseUrl,
      "POST",
      `/shop/items/${secondItem.id}/purchase`,
      {
        token: user.token,
        headers: { "Idempotency-Key": "same-key" },
      }
    );

    assert.equal(second.status, 409);
    assert.deepEqual(await second.json(), {
      error: "Idempotency key was already used for a different purchase",
    });
  });

  it("does not charge coins when the user already owns the item", async () => {
    const user = await createUser("AlreadyOwns", 125);
    const item = await createShopItem();
    await prisma.userShopItem.create({
      data: { userId: user.userId, shopItemId: item.id },
    });

    const res = await request(
      server.baseUrl,
      "POST",
      `/shop/items/${item.id}/purchase`,
      {
        token: user.token,
        headers: { "Idempotency-Key": "owned-key" },
      }
    );

    assert.equal(res.status, 200);
    const body = await res.json();
    assert.equal(body.coins, 125);
    assert.equal(body.purchase.alreadyOwned, true);

    const transactions = await prisma.coinTransaction.findMany({
      where: { userId: user.userId, reason: "shop_purchase" },
    });
    assert.equal(transactions.length, 0);
  });

  it("rejects purchases with insufficient coins", async () => {
    const user = await createUser("LowCoins", 20);
    const item = await createShopItem();

    const res = await request(
      server.baseUrl,
      "POST",
      `/shop/items/${item.id}/purchase`,
      {
        token: user.token,
        headers: { "Idempotency-Key": "low-coins-key" },
      }
    );

    assert.equal(res.status, 400);
    assert.deepEqual(await res.json(), { error: "Insufficient coins" });

    const freshUser = await prisma.user.findUnique({
      where: { id: user.userId },
    });
    assert.equal(freshUser.coins, 20);
  });

  it("equips an owned accessory and clears the slot", async () => {
    const user = await createUser("EquipBuyer", 125);
    const item = await createShopItem({
      renderMetadata: { offsetX: -0.015, offsetY: 0.03, rotation: -0.14 },
    });
    await prisma.userShopItem.create({
      data: { userId: user.userId, shopItemId: item.id },
    });

    const equip = await request(server.baseUrl, "PUT", "/shop/equipment/HEAD", {
      body: { itemId: item.id },
      token: user.token,
    });

    assert.equal(equip.status, 200);
    let body = await equip.json();
    assert.equal(body.equipped.HEAD.id, item.id);
    assert.deepEqual(body.equipped.HEAD.renderMetadata, {
      offsetX: -0.015,
      offsetY: 0.03,
      rotation: -0.14,
    });

    const clear = await request(
      server.baseUrl,
      "PUT",
      "/shop/equipment/HEAD",
      {
        body: { itemId: null },
        token: user.token,
      }
    );

    assert.equal(clear.status, 200);
    body = await clear.json();
    assert.deepEqual(body.equipped, {});
  });

  it("returns a complete equipment map and a consistent bootstrap after replacing a slot", async () => {
    await appSettings.setFlag("apiShopBootstrapV1Enabled", true);
    const user = await createUser("DressingRoomEquip", 125);
    const bunny = await createShopItem({
      sku: "bunny_ears",
      name: "Bunny Ears",
      assetKey: "bunny_ears",
      sortOrder: 1,
    });
    const cowboy = await createShopItem({
      sku: "cowboy_hat",
      name: "Cowboy Hat",
      assetKey: "cowboy_hat",
      sortOrder: 2,
    });
    const scarf = await createShopItem({
      sku: "red_scarf",
      name: "Red Scarf",
      slot: "NECK",
      assetKey: "red_scarf",
      sortOrder: 3,
    });

    await prisma.userShopItem.createMany({
      data: [bunny, cowboy, scarf].map((item) => ({
        userId: user.userId,
        shopItemId: item.id,
      })),
    });
    await prisma.userEquippedAccessory.createMany({
      data: [
        { userId: user.userId, shopItemId: bunny.id, slot: "HEAD" },
        { userId: user.userId, shopItemId: scarf.id, slot: "NECK" },
      ],
    });

    const before = await request(
      server.baseUrl,
      "GET",
      "/shop/bootstrap?localDate=2026-08-27",
      { token: user.token }
    );
    assert.equal(before.status, 200);
    const beforeBody = await before.json();
    assert.equal(beforeBody.contract, "shop-bootstrap-v1");
    assert.deepEqual(
      Object.fromEntries(
        Object.entries(beforeBody.cosmetics.equipped).map(([slot, item]) => [
          slot,
          item.id,
        ])
      ),
      { HEAD: bunny.id, NECK: scarf.id }
    );
    assert.equal(
      beforeBody.cosmetics.items.find((item) => item.id === bunny.id).equipped,
      true
    );
    assert.equal(
      beforeBody.cosmetics.items.find((item) => item.id === cowboy.id).equipped,
      false
    );

    const equip = await request(
      server.baseUrl,
      "PUT",
      "/shop/equipment/HEAD",
      {
        body: { itemId: cowboy.id },
        token: user.token,
      }
    );
    assert.equal(equip.status, 200);
    const equipBody = await equip.json();
    assert.deepEqual(
      Object.fromEntries(
        Object.entries(equipBody.equipped).map(([slot, item]) => [
          slot,
          item.id,
        ])
      ),
      { HEAD: cowboy.id, NECK: scarf.id },
      "equip must return the complete map, including unchanged slots"
    );

    const after = await request(
      server.baseUrl,
      "GET",
      "/shop/bootstrap?localDate=2026-08-27",
      { token: user.token }
    );
    assert.equal(after.status, 200);
    const afterBody = await after.json();
    assert.deepEqual(
      Object.fromEntries(
        Object.entries(afterBody.cosmetics.equipped).map(([slot, item]) => [
          slot,
          item.id,
        ])
      ),
      { HEAD: cowboy.id, NECK: scarf.id }
    );
    assert.equal(
      afterBody.cosmetics.items.find((item) => item.id === bunny.id).equipped,
      false
    );
    assert.equal(
      afterBody.cosmetics.items.find((item) => item.id === cowboy.id).equipped,
      true
    );
    assert.equal(
      afterBody.cosmetics.items.find((item) => item.id === scarf.id).equipped,
      true
    );
  });

  it("rejects equipping an unowned accessory", async () => {
    const user = await createUser("NoEquip", 125);
    const item = await createShopItem();

    const res = await request(server.baseUrl, "PUT", "/shop/equipment/HEAD", {
      body: { itemId: item.id },
      token: user.token,
    });

    assert.equal(res.status, 403);
    assert.deepEqual(await res.json(), {
      error: "You do not own this shop item",
    });
  });
});
