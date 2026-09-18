const assert = require("node:assert/strict");
const { before, beforeEach, describe, it } = require("node:test");
const { cleanDatabase, createTestUser, prisma, request, getSharedServer } = require("./setup");

let server;
let serial = 0;

before(async () => { server = await getSharedServer(); });
beforeEach(async () => { await cleanDatabase(); serial = 0; });

async function goldMembership(userId) {
  const identity = await prisma.billingIdentity.upsert({
    where: { userId },
    create: { userId },
    update: {},
  });
  await prisma.billingSubscription.create({
    data: {
      id: `gold-character-sub-${++serial}`,
      identityId: identity.id,
      productId: "plus_monthly",
      startsAt: new Date(),
      accessUntil: new Date(Date.now() + 86400000),
      givesAccess: true,
      benefitContract: "bara_gold_v1",
      observedAt: new Date(),
    },
  });
  return identity.id;
}

async function character(overrides = {}) {
  return prisma.shopItem.create({
    data: {
      sku: overrides.sku || `mouse-${++serial}`,
      name: overrides.name || "Mouse",
      slot: "CHARACTER",
      priceCoins: overrides.priceCoins ?? 1000,
      assetKey: overrides.assetKey || "mouse",
      active: true,
      ...overrides,
    },
  });
}

describe("Bara Gold character policy", () => {
  it("returns IAP-only policy and rejects coin purchases for non-Gold users", async () => {
    const user = await createTestUser({ coins: 1200 });
    const mouse = await character({ sku: "mouse" });
    const catalog = await request(server.baseUrl, "GET", "/shop/characters", {
      token: user.token,
      headers: { "X-Client-Features": "characters,bara_gold_v1" },
    });
    assert.equal(catalog.status, 200);
    const row = (await catalog.json()).characters.find((item) => item.characterKey === mouse.id);
    assert.deepEqual(row.directPurchase, { available: true, storeProductId: "bara_character_mouse_v1" });
    assert.equal(row.goldAccess, false);
    assert.equal(row.owned, false);
    assert.equal(row.hasAccess, false);
    assert.equal(row.accessSource, null);
    assert.equal(row.coinPurchaseAllowed, false);
    assert.equal(row.canPurchase, false);
    assert.equal(row.unavailableReason, "requires_gold_or_direct_purchase");

    const purchase = await request(server.baseUrl, "POST", `/shop/items/${mouse.id}/purchase`, {
      token: user.token,
      headers: { "Idempotency-Key": "gold-character-free-denied", "X-Client-Features": "characters,bara_gold_v1" },
      body: {},
    });
    assert.equal(purchase.status, 403);
    assert.equal((await purchase.json()).code, "GOLD_CHARACTER_IAP_REQUIRED");
    assert.equal(await prisma.userShopItem.count({ where: { userId: user.user.id, shopItemId: mouse.id } }), 0);
  });

  it("blocks permanent character purchases while Gold is active", async () => {
    const user = await createTestUser({ coins: 1200 });
    const mouse = await character({ sku: "mouse" });
    await goldMembership(user.user.id);
    const purchase = await request(server.baseUrl, "POST", `/shop/items/${mouse.id}/purchase`, {
      token: user.token,
      headers: { "Idempotency-Key": "gold-character-coin-buy", "X-Client-Features": "characters,bara_gold_v1" },
      body: {},
    });
    assert.equal(purchase.status, 403);
    assert.equal((await purchase.json()).code, "GOLD_CHARACTER_PURCHASE_UNAVAILABLE");
    assert.equal(await prisma.userShopItem.count({ where: { userId: user.user.id, shopItemId: mouse.id } }), 0);
  });

  it("allows non-Gold characters to be bought with coins while Gold is active", async () => {
    const user = await createTestUser({ coins: 1200 });
    const turtle = await character({ sku: "turtle", name: "Turtle" });
    await goldMembership(user.user.id);
    const purchase = await request(server.baseUrl, "POST", `/shop/items/${turtle.id}/purchase`, {
      token: user.token,
      headers: { "Idempotency-Key": "gold-standard-character-coin-buy", "X-Client-Features": "characters,bara_gold_v1" },
      body: {},
    });
    assert.equal(purchase.status, 200, JSON.stringify(await purchase.json()));
    assert.equal(await prisma.userShopItem.count({ where: { userId: user.user.id, shopItemId: turtle.id } }), 1);
  });

  it("grants temporary access only to Gold characters", async () => {
    const user = await createTestUser();
    const otter = await character({ sku: "otter", name: "Otter" });
    await goldMembership(user.user.id);
    const response = await request(server.baseUrl, "GET", "/shop/characters", {
      token: user.token,
      headers: { "X-Client-Features": "characters,bara_gold_v1" },
    });
    const row = (await response.json()).characters.find((item) => item.characterKey === otter.id);
    assert.equal(row.owned, false);
    assert.equal(row.hasAccess, false);
    assert.equal(row.accessSource, null);
    assert.equal(row.canActivate, false);
    assert.equal(row.canPurchase, true);
    assert.deepEqual(row.directPurchase, { available: false, storeProductId: null });
    const wardrobe = await request(server.baseUrl, "GET", `/shop/characters/${otter.id}/wardrobe`, {
      token: user.token,
      headers: { "X-Client-Features": "characters,bara_gold_v1" },
    });
    const wardrobeBody = await wardrobe.json();
    assert.equal(wardrobe.status, 403);
    assert.equal(wardrobeBody.code, "CHARACTER_NOT_OWNED");
    const activation = await request(server.baseUrl, "PUT", "/shop/active-character", {
      token: user.token,
      headers: { "X-Client-Features": "characters,bara_gold_v1" },
      body: {
        characterKey: otter.id,
        expectedAppearanceRevision: 0,
        expectedOutfitRevision: 0,
      },
    });
    assert.equal(activation.status, 403, JSON.stringify(await activation.json()));
    assert.equal(await prisma.userShopItem.count({ where: { userId: user.user.id, shopItemId: otter.id } }), 0);
  });

  it("repairs an expired temporary character without touching ownership or wardrobe state", async () => {
    const user = await createTestUser();
    const hedgehog = await character({ sku: "hedgehog", name: "Hedgehog" });
    const identityId = await goldMembership(user.user.id);
    const headers = { "X-Client-Features": "characters,bara_gold_v1" };
    const before = await request(server.baseUrl, "GET", `/shop/characters/${hedgehog.id}/wardrobe`, {
      token: user.token,
      headers,
    });
    const beforeBody = await before.json();
    const activation = await request(server.baseUrl, "PUT", "/shop/active-character", {
      token: user.token,
      headers,
      body: {
        characterKey: hedgehog.id,
        expectedAppearanceRevision: beforeBody.appearanceRevision,
        expectedOutfitRevision: beforeBody.outfit.revision,
      },
    });
    assert.equal(activation.status, 200);
    await prisma.billingSubscription.updateMany({
      where: { identityId },
      data: { accessUntil: new Date(Date.now() - 1000) },
    });

    const collection = await request(server.baseUrl, "GET", "/shop/characters", {
      token: user.token,
      headers,
    });
    assert.equal(collection.status, 200);
    const row = (await collection.json()).characters.find((item) => item.characterKey === hedgehog.id);
    assert.equal(row.owned, false);
    assert.equal(row.hasAccess, false);
    assert.equal(row.active, false);
    assert.equal(await prisma.userShopItem.count({ where: { userId: user.user.id, shopItemId: hedgehog.id } }), 0);
    assert.equal(await prisma.userEquippedAccessory.count({ where: { userId: user.user.id, slot: "CHARACTER" } }), 0);

    await goldMembership(user.user.id);
    const restored = await request(server.baseUrl, "GET", `/shop/characters/${hedgehog.id}/wardrobe`, {
      token: user.token,
      headers,
    });
    const restoredBody = await restored.json();
    assert.equal(restored.status, 200);
    assert.equal(restoredBody.hasAccess, true);
    assert.equal(restoredBody.accessSource, "gold");
    assert.equal(await prisma.userShopItem.count({ where: { userId: user.user.id, shopItemId: hedgehog.id } }), 0);
  });
});
