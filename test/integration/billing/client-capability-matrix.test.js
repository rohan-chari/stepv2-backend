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
  projectId: "client-capability-matrix",
  secretApiKey: "integration-only",
  webhookAuthorization: "Bearer capability-matrix",
  iosAppId: "capability-ios",
  androidAppId: "capability-android",
  termsUrl: "https://barastep.com/billing-terms",
  privacyUrl: "https://barastep.com/privacy",
};

let server;

before(async () => {
  server = await startServer({
    billingConfig: config,
    billingProvider: { async getCustomerHistory() { return { purchases: [], subscriptions: [], observedAt: new Date().toISOString() }; } },
  });
});

after(async () => server?.close());
beforeEach(async () => cleanDatabase());

async function seedCatalog() {
  const rows = [
    ["corgi", "Corgi", "corgi"],
    ["mouse", "Mouse", "mouse"],
    ["hedgehog", "Hedgehog", "hedgehog"],
    ["sea_lion", "Sea Lion", "sea_lion"],
  ];
  for (const [sku, name, assetKey] of rows) {
    await prisma.shopItem.upsert({
      where: { sku },
      create: { sku, name, slot: "CHARACTER", priceCoins: 1000, assetKey },
      update: {},
    });
  }
}

async function legacyMonthly(userId) {
  const identity = await prisma.billingIdentity.create({ data: { userId } });
  await prisma.billingSubscription.create({
    data: {
      id: randomUUID(),
      identityId: identity.id,
      productId: "plus_monthly",
      startsAt: new Date(Date.now() - 86400000),
      periodStartsAt: new Date(Date.now() - 86400000),
      accessUntil: new Date(Date.now() + 86400000),
      givesAccess: true,
      providerStatus: "active",
      trial: false,
      renews: true,
      observedAt: new Date(),
      benefitContract: null,
    },
  });
}

async function goldMonthly(userId) {
  const identity = await prisma.billingIdentity.create({ data: { userId } });
  await prisma.billingSubscription.create({
    data: {
      id: randomUUID(),
      identityId: identity.id,
      productId: "plus_monthly",
      startsAt: new Date(Date.now() - 86400000),
      periodStartsAt: new Date(Date.now() - 86400000),
      accessUntil: new Date(Date.now() + 86400000),
      givesAccess: true,
      providerStatus: "active",
      trial: false,
      renews: true,
      observedAt: new Date(),
      benefitContract: "bara_gold_v1",
    },
  });
}

async function readCase({ features, member = false }) {
  await seedCatalog();
  const account = await createTestUser();
  if (member) await goldMonthly(account.user.id);
  else await legacyMonthly(account.user.id);
  const headers = features === undefined ? undefined : { "X-Client-Features": features };
  const billing = await request(server.baseUrl, "GET", "/billing/bootstrap?platform=ios", {
    token: account.token,
    headers,
  });
  const characters = await request(server.baseUrl, "GET", "/shop/characters", {
    token: account.token,
    headers,
  });
  assert.equal(billing.status, 200);
  assert.equal(characters.status, 200);
  return { billing: await billing.json(), characters: await characters.json() };
}

function assertLegacySafe({ billing, characters }, { normalCharacter = false } = {}) {
  assert.equal(billing.products.some((row) => row.id === "plus_weekly"), false);
  assert.equal(billing.products.some((row) => row.id === "plus_monthly"), true);
  assert.equal(billing.goldPolicy, undefined);
  assert.deepEqual(billing.credits, { paid: 0, trial: 0, trialExpiresAt: null });
  assert.equal(characters.characters.some((row) => ["mouse", "hedgehog", "sea_lion"].includes(row.item?.sku)), false);
  assert.equal(characters.characters.some((row) => row.item?.sku === "corgi"), normalCharacter);
  assert.ok(characters.characters.every((row) => row.directPurchase === undefined));
}

describe("Bara Gold client capability compatibility", () => {
  it("case 1: no capability header is legacy-safe", async () => {
    const result = await readCase({ features: undefined });
    assertLegacySafe(result);
  });

  it("case 2: empty capability header is legacy-safe", async () => {
    const result = await readCase({ features: "" });
    assertLegacySafe(result);
  });

  it("case 3: malformed and unknown tokens fail closed", async () => {
    const result = await readCase({ features: "unknown-token;bara_gold_v1,not/a/token" });
    assertLegacySafe(result);
  });

  it("case 4: legacy billing client receives monthly compatibility only", async () => {
    const result = await readCase({ features: "billing_v1" });
    assertLegacySafe(result);
  });

  it("case 5: character-capable legacy client receives normal characters only", async () => {
    const result = await readCase({ features: "characters" });
    assertLegacySafe(result, { normalCharacter: true });
  });

  it("case 6: Gold-capable but character-incapable client receives Gold billing only", async () => {
    const { billing, characters } = await readCase({ features: "bara_gold_v1", member: true });
    assert.equal(billing.products.some((row) => row.id === "plus_weekly"), true);
    assert.equal(billing.products.find((row) => row.id === "plus_monthly").benefitVersion, "bara_gold_v1");
    assert.deepEqual(billing.goldPolicy, {
      version: "bara_gold_v1",
      isMember: true,
      weeklyProductId: "bara_plus_weekly_v1",
      monthlyProductId: "bara_plus_monthly_v1",
    });
    assert.equal(characters.characters.some((row) => row.item?.slot === "CHARACTER"), false);
  });

  it("case 7: character-capable but Gold-incapable client stays legacy-safe", async () => {
    const result = await readCase({ features: "characters,billing_v1" });
    assertLegacySafe(result, { normalCharacter: true });
  });

  it("case 8: fully capable Gold client receives complete additive policy", async () => {
    const { billing, characters } = await readCase({ features: "characters,bara_gold_v1,billing_v1", member: true });
    assert.equal(billing.products.some((row) => row.id === "plus_weekly"), true);
    assert.equal(billing.products.some((row) => row.id === "plus_monthly"), true);
    assert.equal(billing.goldPolicy.isMember, true);
    const goldRows = characters.characters.filter((row) => ["mouse", "hedgehog", "sea_lion"].includes(row.item?.sku));
    assert.equal(goldRows.length, 3);
    assert.ok(goldRows.every((row) => row.goldAccess === true));
    assert.ok(goldRows.every((row) => row.directPurchase?.available === false));
    assert.ok(goldRows.every((row) => row.coinPurchaseAllowed === false));
    assert.equal(billing.credits.paid, 0);
  });

  it("normalizes whitespace, duplicate tokens, and casing without enabling invalid separators", async () => {
    const valid = await readCase({ features: " characters, BARA_GOLD_V1,characters " });
    assert.equal(valid.billing.goldPolicy.version, "bara_gold_v1");
    assert.equal(valid.characters.characters.filter((row) => row.goldAccess).length, 0);
    const invalid = await readCase({ features: "characters;bara_gold_v1" });
    assert.equal(invalid.billing.goldPolicy, undefined);
    assert.equal(invalid.characters.characters.some((row) => row.goldAccess), false);
  });

  it("removes Gold fields on a capability downgrade for the same account", async () => {
    await seedCatalog();
    const account = await createTestUser();
    await goldMonthly(account.user.id);
    const full = { "X-Client-Features": "characters,bara_gold_v1" };
    let response = await request(server.baseUrl, "GET", "/billing/bootstrap?platform=ios", { token: account.token, headers: full });
    const goldBootstrap = await response.json();
    assert.equal(goldBootstrap.goldPolicy.version, "bara_gold_v1");
    response = await request(server.baseUrl, "GET", "/shop/characters", { token: account.token, headers: full });
    assert.equal((await response.json()).characters.filter((row) => row.goldAccess).length, 4);

    response = await request(server.baseUrl, "GET", "/billing/bootstrap?platform=ios", { token: account.token });
    const downgraded = await response.json();
    assert.equal(downgraded.goldPolicy, undefined);
    assert.equal(downgraded.products.some((row) => row.id === "plus_weekly"), false);
    response = await request(server.baseUrl, "GET", "/shop/characters", { token: account.token });
    const characters = await response.json();
    assert.equal(characters.characters.some((row) => row.goldAccess), false);
    assert.ok(characters.characters.every((row) => row.directPurchase === undefined));
  });

  it("keeps Gold membership and character access isolated between accounts", async () => {
    await seedCatalog();
    const gold = await createTestUser();
    const free = await createTestUser();
    await goldMonthly(gold.user.id);
    const headers = { "X-Client-Features": "characters,bara_gold_v1" };
    const goldBilling = await request(server.baseUrl, "GET", "/billing/bootstrap?platform=ios", { token: gold.token, headers });
    const freeBilling = await request(server.baseUrl, "GET", "/billing/bootstrap?platform=ios", { token: free.token, headers });
    assert.equal((await goldBilling.json()).goldPolicy.isMember, true);
    assert.equal((await freeBilling.json()).goldPolicy.isMember, false);
    const goldCharacters = await request(server.baseUrl, "GET", "/shop/characters", { token: gold.token, headers });
    const freeCharacters = await request(server.baseUrl, "GET", "/shop/characters", { token: free.token, headers });
    const goldMouse = (await goldCharacters.json()).characters.find((row) => row.item?.sku === "mouse");
    const freeMouse = (await freeCharacters.json()).characters.find((row) => row.item?.sku === "mouse");
    assert.equal(goldMouse.coinPurchaseAllowed, false);
    assert.equal(freeMouse.coinPurchaseAllowed, true);
  });
});
