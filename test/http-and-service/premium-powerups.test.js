const assert = require("node:assert/strict");
const { describe, it, before, beforeEach, after } = require("node:test");
const { cleanDatabase, prisma, request, getSharedServer } = require("./setup");

const PREMIUM = [
  ["POWERUP_HITCHHIKE", "HITCHHIKE"],
];
const FEATURES = {
  "X-Client-Features": "characters,spinPowerups,powerups3,powerups4,ads",
};

let server;
let nextAppleId = 0;

async function createUser() {
  const res = await request(server.baseUrl, "POST", "/auth/apple", {
    body: { identityToken: `apple-premium-powerups-${++nextAppleId}` },
  });
  const body = await res.json();
  await prisma.user.update({
    where: { id: body.user.id },
    data: { coins: 10000 },
  });
  return { userId: body.user.id, token: body.sessionToken };
}

async function seedPremiumCatalog() {
  for (const [sku, powerupType] of PREMIUM) {
    await prisma.powerupShopItem.create({
      data: {
        sku,
        name: powerupType,
        description: `${powerupType} test row`,
        powerupType,
        priceCoins: 300,
        active: true,
        testOnly: false,
        dailyRewardEligible: true,
      },
    });
  }
}

describe("premium powerups acquisition defenses — integration", () => {
  before(async () => {
    server = await getSharedServer();
  });

  beforeEach(async () => {
    await cleanDatabase();
    await prisma.powerupShopItem.deleteMany({});
    nextAppleId = 0;
    await seedPremiumCatalog();
  });

  after(async () => {
    await prisma.powerupShopItem.deleteMany({});
  });

  it("blocks non-Gold coin and rewarded-ad acquisition for every premium powerup", async () => {
    const user = await createUser();
    for (const [sku] of PREMIUM) {
      const purchase = await request(server.baseUrl, "POST", "/shop/powerups/purchase", {
        body: { sku },
        token: user.token,
        headers: { ...FEATURES, "Idempotency-Key": `purchase-${sku}` },
      });
      const purchaseBody = await purchase.json();
      assert.equal(purchase.status, 403, sku);
      assert.equal(purchaseBody.code, "GOLD_REQUIRED", sku);

      const unlock = await request(server.baseUrl, "POST", "/shop/powerups/unlock-with-ads", {
        body: { sku, idempotencyKey: `unlock-${sku}` },
        token: user.token,
        headers: { ...FEATURES, "Idempotency-Key": `unlock-${sku}` },
      });
      const unlockBody = await unlock.json();
      assert.equal(unlock.status, 403, sku);
      assert.equal(unlockBody.code, "GOLD_REQUIRED", sku);
    }

    assert.equal((await prisma.user.findUnique({ where: { id: user.userId } })).coins, 10000);
    assert.equal(await prisma.userPowerupItem.count({ where: { userId: user.userId } }), 0);
  });
});
