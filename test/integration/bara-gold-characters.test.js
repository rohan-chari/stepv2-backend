const assert = require("node:assert/strict");
const { before, beforeEach, describe, it } = require("node:test");
const { cleanDatabase, createTestUser, prisma, request, getSharedServer } = require("./setup");

let server;
let serial = 0;

before(async () => { server = await getSharedServer(); });
beforeEach(async () => { await cleanDatabase(); serial = 0; });

async function goldMembership(userId) {
  const identity = await prisma.billingIdentity.create({ data: { userId } });
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
  it("returns server-owned Gold/direct-purchase policy and denies free coin purchase", async () => {
    const user = await createTestUser({ coins: 500 });
    const mouse = await character({ sku: "mouse" });
    const catalog = await request(server.baseUrl, "GET", "/shop/characters", {
      token: user.token,
      headers: { "X-Client-Features": "characters,bara_gold_v1" },
    });
    assert.equal(catalog.status, 200);
    const row = (await catalog.json()).characters.find((item) => item.characterKey === mouse.id);
    assert.deepEqual(row.directPurchase, { available: true, storeProductId: "bara_character_mouse_v1" });
    assert.equal(row.goldAccess, true);
    assert.equal(row.coinPurchaseAllowed, false);
    assert.equal(row.canPurchase, false);
    assert.equal(row.unavailableReason, "requires_gold_or_direct_purchase");

    const purchase = await request(server.baseUrl, "POST", `/shop/items/${mouse.id}/purchase`, {
      token: user.token,
      headers: { "Idempotency-Key": "gold-character-free-denied", "X-Client-Features": "characters,bara_gold_v1" },
      body: {},
    });
    assert.equal(purchase.status, 403);
    assert.equal((await purchase.json()).code, "GOLD_REQUIRED");
    assert.equal((await prisma.user.findUnique({ where: { id: user.user.id } })).coins, 500);
  });

  it("allows only an active Gold member to buy the character with coins", async () => {
    const user = await createTestUser({ coins: 1200 });
    const mouse = await character({ sku: "mouse" });
    await goldMembership(user.user.id);
    const purchase = await request(server.baseUrl, "POST", `/shop/items/${mouse.id}/purchase`, {
      token: user.token,
      headers: { "Idempotency-Key": "gold-character-coin-buy", "X-Client-Features": "characters,bara_gold_v1" },
      body: {},
    });
    assert.equal(purchase.status, 200);
    assert.equal((await purchase.json()).purchase.coinsSpent, 850);
    assert.equal(await prisma.userShopItem.count({ where: { userId: user.user.id, shopItemId: mouse.id } }), 1);
  });
});
