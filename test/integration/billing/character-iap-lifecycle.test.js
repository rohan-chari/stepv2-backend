const assert = require("node:assert/strict");
const { before, after, beforeEach, describe, it } = require("node:test");
const { randomUUID } = require("node:crypto");

const {
  cleanDatabase,
  createTestUser,
  prisma,
  request,
  startServer,
} = require("../setup");

const config = {
  projectId: "character-iap-lifecycle",
  secretApiKey: "integration-only",
  webhookAuthorization: "Bearer character-iap-webhook",
  iosAppId: "character-iap-ios",
  androidAppId: "character-iap-android",
  termsUrl: "https://barastep.com/billing-terms",
  privacyUrl: "https://barastep.com/privacy",
};

const products = {
  sea_lion: { internal: "character_sea_lion", store: "bara_character_sea_lion_v1" },
  mouse: { internal: "character_mouse", store: "bara_character_mouse_v1" },
  hedgehog: { internal: "character_hedgehog", store: "bara_character_hedgehog_v1" },
};

let server;
let history;
let sequence = 0;

before(async () => {
  server = await startServer({
    billingConfig: config,
    billingProvider: { async getCustomerHistory() { return history; } },
  });
});

after(async () => server?.close());

beforeEach(async () => {
  await cleanDatabase();
  sequence = 0;
  history = { purchases: [], subscriptions: [], observedAt: new Date().toISOString() };
});

async function seedCharacters() {
  const rows = {};
  for (const sku of Object.keys(products)) {
    rows[sku] = await prisma.shopItem.create({
      data: {
        sku,
        name: sku.replace("_", " "),
        slot: "CHARACTER",
        priceCoins: 1000,
        assetKey: sku,
      },
    });
  }
  return rows;
}

function directPurchase(sku, overrides = {}) {
  const product = products[sku];
  const transactionId = overrides.transactionId || `${sku}-transaction-${++sequence}`;
  const purchasedAt = overrides.purchasedAt || new Date(Date.now() - 1000).toISOString();
  return {
    transactionId,
    providerId: overrides.providerId || `${transactionId}-provider`,
    productId: product.internal,
    appId: config.iosAppId,
    store: "app_store",
    environment: "production",
    purchasedAt,
    expiresAt: null,
    quantity: 1,
    paid: true,
    refunded: false,
    purchaseStatus: "owned",
    subscriptionId: null,
    ...overrides,
  };
}

async function sync(token) {
  const response = await request(server.baseUrl, "POST", "/billing/sync?platform=ios", {
    token,
    body: {},
  });
  assert.equal(response.status, 200);
  return response.json();
}

async function setupUser() {
  const owner = await createTestUser();
  return owner;
}

async function ownership(userId, shopItemId) {
  return prisma.userShopItem.findUnique({ where: { userId_shopItemId: { userId, shopItemId } } });
}

async function sources(userId, shopItemId) {
  return prisma.shopItemOwnershipSource.findMany({ where: { userId, shopItemId }, orderBy: { createdAt: "asc" } });
}

async function sendWebhook(identityId, transactionId, productId, id = randomUUID(), type = "CANCELLATION") {
  const response = await request(server.baseUrl, "POST", "/billing/webhook/revenuecat", {
    headers: { Authorization: config.webhookAuthorization },
    body: {
      event: {
        id,
        type,
        cancel_reason: type === "CANCELLATION" ? "CUSTOMER_SUPPORT" : undefined,
        app_user_id: identityId,
        app_id: config.iosAppId,
        store: "APP_STORE",
        environment: "PRODUCTION",
        product_id: productId,
        transaction_id: transactionId,
        event_timestamp_ms: Date.now(),
      },
    },
  });
  assert.equal(response.status, 200);
}

describe("direct character IAP lifecycle", () => {
  it("maps each Gold character product to only its intended character and grants exact provenance", async () => {
    const items = await seedCharacters();
    for (const sku of Object.keys(products)) {
      const owner = await setupUser();
      const purchase = directPurchase(sku);
      history = { purchases: [purchase], subscriptions: [], observedAt: new Date().toISOString() };
      await sync(owner.token);
      assert.ok(await ownership(owner.user.id, items[sku].id));
      const rowSources = await sources(owner.user.id, items[sku].id);
      assert.equal(rowSources.length, 1);
      assert.equal(rowSources[0].source.startsWith("DIRECT_IAP:"), true);
      assert.equal(rowSources[0].verifiedTransactionRef.includes(`${sku}-transaction`), true);
      for (const other of Object.keys(products).filter((candidate) => candidate !== sku)) {
        assert.equal(await ownership(owner.user.id, items[other].id), null);
      }
      const identity = await prisma.billingIdentity.findUnique({ where: { userId: owner.user.id } });
      const receipt = await prisma.billingPurchase.findFirst({ where: { identityId: identity.id } });
      assert.equal(receipt.transactionId, purchase.transactionId);
      assert.equal(receipt.providerId, purchase.providerId);
      assert.equal(receipt.productId, products[sku].internal);
      assert.equal(receipt.identityId, identity.id);
      assert.equal(receipt.canonicalKey, JSON.stringify([
        config.projectId,
        config.iosAppId,
        "app_store",
        "production",
        receipt.transactionId,
      ]));
      assert.equal(await prisma.billingPurchase.count({ where: { identityId: identity.id } }), 1);
    }
  });

  it("replays the same transaction through sync and reconciliation without duplicates", async () => {
    const items = await seedCharacters();
    const owner = await setupUser();
    const purchase = directPurchase("mouse");
    history = { purchases: [purchase], subscriptions: [], observedAt: new Date().toISOString() };
    await sync(owner.token);
    await sync(owner.token);
    await sync(owner.token);
    assert.equal(await prisma.billingPurchase.count({ where: { transactionId: purchase.transactionId } }), 1);
    assert.equal(await prisma.shopItemOwnershipSource.count({ where: { userId: owner.user.id, shopItemId: items.mouse.id } }), 1);
    assert.equal(await prisma.userShopItem.count({ where: { userId: owner.user.id, shopItemId: items.mouse.id } }), 1);
  });

  it("restores direct ownership on the same account and a fresh session", async () => {
    const items = await seedCharacters();
    const owner = await setupUser();
    const purchase = directPurchase("sea_lion");
    history = { purchases: [purchase], subscriptions: [], observedAt: new Date().toISOString() };
    await sync(owner.token);
    await sync(owner.token);
    assert.ok(await ownership(owner.user.id, items.sea_lion.id));
    assert.equal(await prisma.shopItemOwnershipSource.count({ where: { userId: owner.user.id, shopItemId: items.sea_lion.id } }), 1);
  });

  it("revokes only the refunded direct source when it is the sole source", async () => {
    const items = await seedCharacters();
    const owner = await setupUser();
    const purchase = directPurchase("mouse");
    history = { purchases: [purchase], subscriptions: [], observedAt: new Date().toISOString() };
    await sync(owner.token);
    history.purchases = [directPurchase("mouse", { ...purchase, refunded: true, purchaseStatus: "refunded" })];
    await sync(owner.token);
    const row = (await sources(owner.user.id, items.mouse.id))[0];
    assert.ok(row.revokedAt);
    assert.equal(await ownership(owner.user.id, items.mouse.id), null);
    assert.equal(await prisma.billingPurchase.count({ where: { transactionId: purchase.transactionId } }), 1);
  });

  it("keeps coin ownership when the matching direct IAP is refunded", async () => {
    const items = await seedCharacters();
    const owner = await setupUser();
    const purchase = directPurchase("hedgehog");
    history = { purchases: [purchase], subscriptions: [], observedAt: new Date().toISOString() };
    await sync(owner.token);
    await prisma.shopItemOwnershipSource.create({
      data: { userId: owner.user.id, shopItemId: items.hedgehog.id, source: "COIN_PURCHASE" },
    });
    history.purchases = [directPurchase("hedgehog", { ...purchase, refunded: true, purchaseStatus: "refunded" })];
    await sync(owner.token);
    const rowSources = await sources(owner.user.id, items.hedgehog.id);
    assert.equal(rowSources.length, 2);
    assert.ok(rowSources.find((row) => row.source === "COIN_PURCHASE" && !row.revokedAt));
    assert.ok(await ownership(owner.user.id, items.hedgehog.id));
  });

  it("preserves a later direct purchase after an old transaction is refunded", async () => {
    const items = await seedCharacters();
    const owner = await setupUser();
    const first = directPurchase("sea_lion", { transactionId: "sea-lion-a" });
    const second = directPurchase("sea_lion", { transactionId: "sea-lion-b" });
    history = { purchases: [first], subscriptions: [], observedAt: new Date().toISOString() };
    await sync(owner.token);
    history.purchases = [
      { ...first, refunded: true, purchaseStatus: "refunded" },
      second,
    ];
    await sync(owner.token);
    const rowSources = await sources(owner.user.id, items.sea_lion.id);
    assert.equal(rowSources.length, 2);
    assert.ok(rowSources.find((row) => row.verifiedTransactionRef.includes("sea-lion-a") && row.revokedAt));
    assert.ok(rowSources.find((row) => row.verifiedTransactionRef.includes("sea-lion-b") && !row.revokedAt));
    assert.ok(await ownership(owner.user.id, items.sea_lion.id));
  });

  it("handles a duplicate refund webhook without a second ownership mutation", async () => {
    const items = await seedCharacters();
    const owner = await setupUser();
    const purchase = directPurchase("mouse");
    history = { purchases: [purchase], subscriptions: [], observedAt: new Date().toISOString() };
    await sync(owner.token);
    const identity = await prisma.billingIdentity.findUnique({ where: { userId: owner.user.id } });
    await sendWebhook(identity.id, purchase.transactionId, products.mouse.store, "refund-character-mouse");
    await sendWebhook(identity.id, purchase.transactionId, products.mouse.store, "refund-character-mouse");
    assert.equal(await prisma.billingInbox.count(), 1);
    // The provider still reports the purchase as owned: the refund signal is
    // the webhook's durable source of truth for this reconciliation pass.
    history.purchases = [purchase];
    await sync(owner.token);
    const source = (await sources(owner.user.id, items.mouse.id))[0];
    assert.ok(source.revokedAt);
    assert.equal(await prisma.shopItemOwnershipSource.count({ where: { userId: owner.user.id, shopItemId: items.mouse.id, revokedAt: null } }), 0);
    assert.equal(await prisma.billingPurchase.count({ where: { transactionId: purchase.transactionId } }), 1);
  });

  it("rejects foreign, unknown, mismatched, and revoked direct transactions", async () => {
    await seedCharacters();
    const first = await setupUser();
    const purchase = directPurchase("mouse", { transactionId: "foreign-character-transaction" });
    history = { purchases: [purchase], subscriptions: [], observedAt: new Date().toISOString() };
    await sync(first.token);
    const second = await setupUser();
    const foreign = await request(server.baseUrl, "POST", "/billing/sync?platform=ios", { token: second.token, body: {} });
    assert.equal(foreign.status, 409);

    history = { purchases: [directPurchase("mouse", { transactionId: "revoked-character", refunded: true, purchaseStatus: "refunded" })], subscriptions: [], observedAt: new Date().toISOString() };
    const revoked = await request(server.baseUrl, "POST", "/billing/sync?platform=ios", { token: second.token, body: {} });
    assert.equal(revoked.status, 200);
    assert.equal(await prisma.userShopItem.count({ where: { userId: second.user.id } }), 0);

    history = { purchases: [{ ...purchase, productId: "unsupported_character_product", transactionId: "unknown-product" }], subscriptions: [], observedAt: new Date().toISOString() };
    const unknown = await request(server.baseUrl, "POST", "/billing/sync?platform=ios", { token: second.token, body: {} });
    assert.equal(unknown.status, 503);
    assert.equal(await prisma.userShopItem.count({ where: { userId: second.user.id } }), 0);

    history = { purchases: [directPurchase("mouse", { transactionId: "wrong-app", appId: "wrong-app-id" })], subscriptions: [], observedAt: new Date().toISOString() };
    const wrongApp = await request(server.baseUrl, "POST", "/billing/sync?platform=ios", { token: second.token, body: {} });
    assert.equal(wrongApp.status, 503);
    assert.equal(await prisma.userShopItem.count({ where: { userId: second.user.id } }), 0);
  });

  it("retains ownership when two valid direct sources exist and one is revoked", async () => {
    const items = await seedCharacters();
    const owner = await setupUser();
    const a = directPurchase("mouse", { transactionId: "mouse-a" });
    const b = directPurchase("mouse", { transactionId: "mouse-b" });
    history = { purchases: [a, b], subscriptions: [], observedAt: new Date().toISOString() };
    await sync(owner.token);
    history.purchases = [{ ...a, refunded: true, purchaseStatus: "refunded" }, b];
    await sync(owner.token);
    assert.ok(await ownership(owner.user.id, items.mouse.id));
    assert.equal(await prisma.shopItemOwnershipSource.count({ where: { userId: owner.user.id, shopItemId: items.mouse.id, revokedAt: null } }), 1);
  });
});
